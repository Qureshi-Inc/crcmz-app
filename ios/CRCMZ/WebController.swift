import SafariServices
import UIKit
import WebKit

/// app.crcmz.me/app in a full-screen web view: camera and mic for calls, inline and
/// background video, swipe back, pull to refresh. Only CRCMZ pages load here; any other
/// site opens in Safari. Push tokens reach the server through the signed-in page
/// (frontend/src/lib/native.ts → /api/push/native).
final class WebController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let origin = "https://app.crcmz.me"
    /// Pages that belong in the app: the app itself and the sign-in pages.
    private static let hosts: Set<String> = ["app.crcmz.me", "auth.crcmz.me"]

    private var webView: WKWebView!
    private var pending: [String: String] = [:]   // push token -> platform, until the server has it
    private var registering = false
    private var calls: CallHost?
    private let shell = Shell()

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.applicationNameForUserAgent = "CRCMZ-iOS/1.0"
        config.websiteDataStore = .default()
        // Huddle and Watch Party calls are handed to the app (NativeCall).
        config.userContentController.add(self, name: "crcmzCall")
        // The tab bar is the app's own (Shell).
        config.userContentController.add(self, name: "crcmzShell")
        // Slap's music plays through the app (NativeAudio).
        config.userContentController.add(self, name: "crcmzAudio")
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
        let root = UIView()
        root.backgroundColor = webView.backgroundColor
        root.addSubview(webView)
        root.addSubview(shell.bar)
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        shell.presenter = self
        NativeAudio.shared.start(web: webView)
        #if DEBUG
        if let files = UserDefaults.standard.string(forKey: "crcmzAudioDemo") { NativeAudio.shared.demo(files.components(separatedBy: ",")) }
        #endif
        shell.go = { [weak self] path in
            self?.webView.callAsyncJavaScript("window.__crcmzGo ? window.__crcmzGo(path) : location.assign('/app' + path)",
                                              arguments: ["path": path], in: nil, in: .page)
        }
        shell.onVisible = { [weak self] _ in
            UIView.animate(withDuration: 0.2) { self?.view.setNeedsLayout(); self?.view.layoutIfNeeded() }
        }
        let host = CallHost(in: self)
        calls = host
        NativeCall.shared.onTiles = { [weak host] in host?.tilesChanged() }
        NativeCall.shared.onEnded = { [weak self] kind in
            self?.webView.evaluateJavaScript("window.__crcmzCallEnded && window.__crcmzCallEnded('\(kind.rawValue)')")
        }
        webView.load(URLRequest(url: URL(string: Self.origin + "/app?crcmz_app=ios")!))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let b = view.bounds
        if shell.isVisible {
            let h = 49 + view.safeAreaInsets.bottom
            shell.bar.frame = CGRect(x: 0, y: b.height - h, width: b.width, height: h)
            webView.frame = CGRect(x: 0, y: 0, width: b.width, height: b.height - h)
        } else {
            webView.frame = b
        }
        calls?.layout()
    }

    /// The page hands over a call (start / join / show / end; see NativeCall).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "app.crcmz.me",
              let body = message.body as? [String: Any] else { return }
        switch message.name {
        case "crcmzShell": shell.update(body)
        case "crcmzAudio": NativeAudio.shared.handle(body)
        default: NativeCall.shared.handle(body)
        }
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

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        shell.pageChanged(webView.url)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        shell.pageChanged(webView.url)
        flushTokens()
        #if DEBUG
        // Simulator check of the native bar without signing in: -crcmzShellDemo YES.
        if UserDefaults.standard.bool(forKey: "crcmzShellDemo") {
            shell.pageChanged(URL(string: Self.origin + "/app"))
            let t = { (id: String, l: String, g: String) in ["id": id, "label": l, "path": "/" + id, "group": g] }
            shell.update(["tabs": [t("squad", "Squad", ""), t("slap", "Slap", ""), t("ask", "Ask AI", ""), t("watch", "Watch", "")],
                          "more": [t("clips", "Clips", "squad"), t("huddle", "Huddle", "squad"), t("settings", "Settings", "account")],
                          "active": "slap", "badge": 3, "hidden": false])
            if UserDefaults.standard.bool(forKey: "crcmzShellDemoMore") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.shell.demoMore() }
            }
        }
        #endif
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
