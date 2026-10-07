import CallKit
import PushKit
import UIKit

/// A Huddle, Watch Party or Rally ring on the iPhone's own call screen (CallKit), woken by
/// a VoIP push (PushKit) even when the app is closed. Answer opens the Huddle or party in
/// the app; the call itself is the web page's, so the system call ends as soon as it's
/// answered. Apple requires every VoIP push to show a call, so the server sends them for
/// rings only.
///
/// For Huddle rings, answering also auto-joins the LiveKit room: on answer we fetch a fresh
/// token from /api/huddle/join_token and call NativeCall directly, so the user is in the
/// call before the web page has finished loading. This works on cold and warm launch because
/// the session cookie is stored in the keychain by SharedSession.
final class Calls: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = Calls()
    private static let ringSeconds = 30.0

    private weak var web: WebController?
    private let registry = PKPushRegistry(queue: .main)
    /// Ringing call UUID -> path to open on answer.
    private var calls: [UUID: String] = [:]
    /// Ringing call UUID -> Huddle room name (empty for Watch / Rally rings).
    private var callRooms: [UUID: String] = [:]
    private lazy var provider: CXProvider = {
        let c = CXProviderConfiguration()
        c.supportsVideo = true
        c.maximumCallGroups = 1
        c.maximumCallsPerCallGroup = 1
        c.supportedHandleTypes = [.generic]
        c.includesCallsInRecents = false
        if let icon = UIImage(systemName: "person.3.fill") { c.iconTemplateImageData = icon.pngData() }
        let p = CXProvider(configuration: c)
        p.setDelegate(self, queue: .main)
        return p
    }()

    func start(web: WebController) {
        self.web = web
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    // MARK: PushKit

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        web?.register(token: credentials.token.map { String(format: "%02x", $0) }.joined(), platform: "ios-voip")
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType, completion: @escaping () -> Void) {
        let d = payload.dictionaryPayload
        let title = d["title"] as? String ?? "CRCMZ"
        let caller = (d["caller"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? title
        let id = UUID()
        let path = d["url"] as? String ?? "/app"
        calls[id] = path
        // Extract the room name for Huddle rings so we can auto-join on answer.
        // The push URL looks like /app/huddle?room=crcmz.
        if let comps = URLComponents(string: "https://app.crcmz.me" + path),
           comps.path.hasPrefix("/app/huddle"),
           let room = comps.queryItems?.first(where: { $0.name == "room" })?.value, !room.isEmpty {
            callRooms[id] = room
        }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = title
        update.hasVideo = true
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportNewIncomingCall(with: id, update: update) { _ in completion() }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.ringSeconds) { [weak self] in
            guard let self, self.calls.removeValue(forKey: id) != nil else { return }
            self.provider.reportCall(with: id, endedAt: nil, reason: .unanswered)
        }
    }

    // MARK: CallKit

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        action.fulfill()
        let id = action.callUUID
        let path = calls.removeValue(forKey: id) ?? "/app"
        let room = callRooms.removeValue(forKey: id) ?? ""
        web?.open(path: path)
        // For Huddle rings: auto-join the LiveKit room without waiting for the page.
        if !room.isEmpty { autoJoinHuddle(room: room) }
        // The Huddle / party is the page's own call: let the system call go.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            provider.reportCall(with: id, endedAt: nil, reason: .remoteEnded)
        }
    }

    /// Fetch a fresh LiveKit token from the server and connect to the Huddle room
    /// directly, before the page has loaded. Works on cold launch because the session
    /// cookie is kept in the keychain by SharedSession.
    private func autoJoinHuddle(room: String) {
        guard let cookie = SharedSession.read() else { return }
        let encoded = room.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? room
        guard let url = URL(string: "https://app.crcmz.me/api/huddle/join_token?room=\(encoded)") else { return }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.setValue("psn_session=\(cookie)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = j["token"] as? String,
                  let wsUrl = j["url"] as? String else { return }
            DispatchQueue.main.async {
                NativeCall.shared.handle([
                    "type": "start", "kind": "huddle",
                    "url": wsUrl, "token": token,
                    "title": "Huddle", "room": room,
                    "publish": true, "camera": false, "mic": true,
                ])
            }
        }.resume()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        calls.removeValue(forKey: action.callUUID)
        callRooms.removeValue(forKey: action.callUUID)
        action.fulfill()
    }

    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
        callRooms.removeAll()
    }
}
