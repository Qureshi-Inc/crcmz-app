import AVFoundation
import UIKit

/// The CRCMZ iOS app: app.crcmz.me/app full screen (WebController), plus what a web page
/// can't do on an iPhone: notifications (Push) and Huddle / Watch Party rings on the
/// system call screen (Calls). A site deploy updates everything else.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    let web = WebController()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // A video keeps playing with the screen off or the app in the background.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = web
        window?.makeKeyAndVisible()
        Push.shared.start(web: web)
        Calls.shared.start(web: web)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.didRegister(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("crcmz: no APNs token: \(error.localizedDescription)")
    }

    /// app.crcmz.me/app links (universal links) open here.
    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL else { return false }
        web.open(url)
        return true
    }
}
