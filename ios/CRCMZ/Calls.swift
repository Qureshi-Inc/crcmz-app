import CallKit
import PushKit
import UIKit

/// A Huddle, Watch Party or Rally ring on the iPhone's own call screen (CallKit), woken by
/// a VoIP push (PushKit) even when the app is closed. Answer opens the Huddle or party in
/// the app; the call itself is the web page's, so the system call ends as soon as it's
/// answered. Apple requires every VoIP push to show a call, so the server sends them for
/// rings only.
final class Calls: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = Calls()
    private static let ringSeconds = 30.0

    private weak var web: WebController?
    private let registry = PKPushRegistry(queue: .main)
    private var calls: [UUID: String] = [:]   // ringing call -> the page to open
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
        calls[id] = d["url"] as? String ?? "/app"
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
        if let path = calls.removeValue(forKey: id) { web?.open(path: path) }
        // The Huddle / party is the page's own call: let the system call go.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            provider.reportCall(with: id, endedAt: nil, reason: .remoteEnded)
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        calls.removeValue(forKey: action.callUUID)
        action.fulfill()
    }

    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
    }
}
