import Foundation
import Security

/// The app's signed-in session (a copy of ios/CRCMZ/SharedSession.swift, read side only): Share → CRCMZ from Spotify
/// or Apple Music posts the song to the server as you. It's the web view's session cookie,
/// kept in a keychain group only this team's apps can read; nothing else is stored.
enum SharedSession {
    static let group = "CF6R3NUAP7.me.crcmz.shared"
    private static let account = "psn_session"
    private static let service = "app.crcmz.me"

    static func write(_ value: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group]
        let data = Data(value.utf8)
        let found = SecItemCopyMatching(base.merging([kSecReturnData as String: true]) { $1 } as CFDictionary, nil)
        if found == errSecSuccess {
            SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            SecItemAdd(base.merging([kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]) { $1 } as CFDictionary, nil)
        }
    }

    static func read() -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group,
                                kSecReturnData as String: true]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
