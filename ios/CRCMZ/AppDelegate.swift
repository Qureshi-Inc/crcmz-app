import AVFoundation
import SwiftUI
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
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-crcmzWidgetDemo") {
            window?.rootViewController = UIHostingController(rootView: WidgetGallery())
        }
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-crcmzLiveGallery") {
            let args = ProcessInfo.processInfo.arguments
            window?.rootViewController = UIHostingController(rootView: LiveGallery(page: i + 1 < args.count ? args[i + 1] : "lock"))
        }
        #endif
        window?.makeKeyAndVisible()
        #if DEBUG
        // Screenshots signed in as someone (WebController): no push, ring or Live Activity
        // tokens from the simulator reach their account.
        if WebController.screenshotSession != nil { return true }
        #endif
        Push.shared.start(web: web)
        Calls.shared.start(web: web)
        LiveActivities.start()
        return true
    }

    /// A widget or a Live Activity: crcmz://open?path=/app/… opens that page.
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == "crcmz" else { return false }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value
        web.open(path: path ?? "/app")
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
