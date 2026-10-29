import Foundation
import Security
import UIKit

/// The Watch Party's poster for the Live Activity. An activity's view can't load anything
/// itself, so the app (and the Live now widget) fetch a small copy and keep it in the
/// keychain group the app already shares with its extensions (like SlapNow); the view reads it.
/// One poster at a time: the party that's on.
enum LivePoster {
    private static let group = "CF6R3NUAP7.me.crcmz.shared"
    private static let account = "live_poster"
    private static let service = "app.crcmz.me"

    private struct Stored: Codable {
        var url: String
        var jpeg: Data
    }

    /// The poster for `url`, if it's the one kept.
    static func image(for url: String?) -> UIImage? {
        guard let url, !url.isEmpty, let s = read(), s.url == url else { return nil }
        return UIImage(data: s.jpeg)
    }

    /// Fetch and keep `url`'s poster unless it's already kept. Only https links (signed ones
    /// on app.crcmz.me, or outside artwork) are fetched.
    static func cache(_ url: String?) async {
        guard let url, url.hasPrefix("https://"), let u = URL(string: url), read()?.url != url else { return }
        guard let (d, resp) = try? await URLSession.shared.data(from: u),
              (resp as? HTTPURLResponse)?.statusCode == 200, let img = UIImage(data: d) else { return }
        // Small: a Live Activity's images have to be little more than the size they're shown at.
        let h: CGFloat = 150
        let size = CGSize(width: h * img.size.width / max(1, img.size.height), height: h)
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = small.jpegData(compressionQuality: 0.75) else { return }
        write(Stored(url: url, jpeg: jpeg))
    }

    private static func read() -> Stored? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group,
                                kSecReturnData as String: true]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: d)
    }

    private static func write(_ s: Stored) {
        guard let data = try? JSONEncoder().encode(s) else { return }
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group]
        if SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            SecItemAdd(base.merging([kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]) { $1 } as CFDictionary, nil)
        }
    }
}
