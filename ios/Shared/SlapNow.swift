import AppIntents
import Foundation
import Security

/// What Slap is playing, for the Slap widget: the app (NativeAudio.swift) writes it on every
/// change, the widget reads it. Kept in the keychain group the app already shares with its
/// extensions (SharedSession), so nothing new needs signing. `loaded` is false when nothing
/// is in the player (or the app was started fresh): the widget then shows the last song and
/// a Resume that opens Slap.
struct SlapNow: Codable, Equatable {
    var title: String
    var artist: String
    var art: String        // the cover's URL on app.crcmz.me (the widget fetches it as you)
    var playing: Bool
    var loaded: Bool

    static let widgetKind = "me.crcmz.slap"
    private static let group = "CF6R3NUAP7.me.crcmz.shared"
    private static let account = "slap_now"
    private static let service = "app.crcmz.me"

    static func read() -> SlapNow? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group,
                                kSecReturnData as String: true]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(SlapNow.self, from: d)
    }

    func write() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                                   kSecAttrAccount as String: Self.account, kSecAttrAccessGroup as String: Self.group]
        if SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            SecItemAdd(base.merging([kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]) { $1 } as CFDictionary, nil)
        }
    }
}

/// The app's side of the widget's buttons: NativeAudio sets it. nil in the widget extension,
/// which never runs the intent itself (an AudioPlaybackIntent runs in the app).
@MainActor
enum SlapControl {
    static var handler: ((String) -> Bool)?
}

/// Play / pause, previous and next on the Slap widget (iOS 17+). An AudioPlaybackIntent, so
/// the system runs it in the app, where the player is.
@available(iOS 17.0, *)
struct SlapControlIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "Control Slap"
    static var isDiscoverable = false

    @Parameter(title: "Action") var action: String

    init() {}
    init(_ action: String) { self.action = action }

    @MainActor
    func perform() async throws -> some IntentResult {
        // Nothing to control (the app was closed and started fresh): the widget shows Resume.
        if SlapControl.handler?(action) != true, var now = SlapNow.read() {
            now.loaded = false
            now.playing = false
            now.write()
        }
        return .result()
    }
}
