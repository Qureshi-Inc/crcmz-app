import SafariServices
import UIKit
import WebKit

/// app.crcmz.me/app in a full-screen web view: camera and mic for calls, inline and
/// background video, swipe back, pull to refresh. Only CRCMZ pages load here; any other
/// site opens in Safari. Push tokens reach the server through the signed-in page
/// (frontend/src/lib/native.ts → /api/push/native).
final class WebController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    static let origin = "https://app.crcmz.me"
    /// Pages that belong in the app: the app itself and the sign-in pages.
    private static let hosts: Set<String> = ["app.crcmz.me", "auth.crcmz.me"]

    private var webView: WKWebView!
    private var pending: [String: String] = [:]   // push token -> platform, until the server has it
    private var registering = false

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.applicationNameForUserAgent = "CRCMZ-iOS/1.0"
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.02, green: 0.012, blue: 0.06, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        // The page lays itself out around the notch and home bar (viewport-fit=cover).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        let refresh = UIRefreshControl()
        refresh.tintColor = .white
        refresh.addTarget(self, action: #selector(reloadPage(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: Self.origin + "/app?crcmz_app=ios")!))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    @objc private func reloadPage(_ sender: UIRefreshControl) {
        webView.reload()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { sender.endRefreshing() }
    }

    // MARK: Opening pages

    /// A notification, a ring or a link: open that CRCMZ page (nothing else).
    func open(_ url: URL) {
        guard url.scheme == "https", url.host == "app.crcmz.me", url.path.hasPrefix("/app") else { return }
        if isViewLoaded { webView.load(URLRequest(url: url)) }
    }

    func open(path: String) {
        let p = path.hasPrefix("/app") && !path.contains("//") ? path : "/app"
        if let url = URL(string: Self.origin + p) { open(url) }
    }

    // MARK: Push tokens

    func register(token: String, platform: String) {
        pending[token] = platform
        flushTokens()
    }

    /// Hand waiting tokens to the page; it posts them if someone is signed in, and we try
    /// again after the next page load if not.
    private func flushTokens() {
        guard !registering, let (token, platform) = pending.first, isViewLoaded,
              webView.url?.host == "app.crcmz.me" else { return }
        registering = true
        webView.callAsyncJavaScript(
            "return window.__crcmzNative ? await window.__crcmzNative(token, platform) : false",
            arguments: ["token": token, "platform": platform], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            self.registering = false
            if case .success(let ok) = result, (ok as? Bool) == true {
                self.pending.removeValue(forKey: token)
                self.flushTokens()
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        flushTokens()
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Embedded players (YouTube trailers, the party's videos) load inside the page.
        if action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        if let host = url.host, Self.hosts.contains(host) { return decisionHandler(.allow) }
        if url.scheme == "https" || url.scheme == "http" {
            present(SFSafariViewController(url: url), animated: true)
        } else if UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)   // whatsapp:, mailto:, tel:
        }
        decisionHandler(.cancel)
    }

    /// target=_blank: CRCMZ pages open here, anything else in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if let host = url.host, Self.hosts.contains(host) { webView.load(URLRequest(url: url)) }
            else { present(SFSafariViewController(url: url), animated: true) }
        }
        return nil
    }

    /// Camera and mic for Huddle and Watch Party calls, on CRCMZ pages only.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "app.crcmz.me" ? .grant : .deny)
    }

    // alert() / confirm() from the page, as native alerts.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    /// The page died in the background (memory): bring it back rather than show white.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}
