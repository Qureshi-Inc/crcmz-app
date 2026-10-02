import UIKit
import UserNotifications

/// Notifications (mentions, movies, Squad Up, …) as real iPhone notifications through
/// APNs (apns.py on the server): the web view itself can't get Web Push. Tapping one opens
/// the page it names. Rings come separately, through PushKit (Calls).
final class Push: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Push()
    private weak var web: WebController?

    func start(web: WebController) {
        self.web = web
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func didRegister(_ deviceToken: Data) {
        web?.register(token: deviceToken.map { String(format: "%02x", $0) }.joined(), platform: "ios")
    }

    /// In the app: still show it, the way other apps do.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        if let path = response.notification.request.content.userInfo["url"] as? String {
            web?.open(path: path)
        }
        done()
    }
}
