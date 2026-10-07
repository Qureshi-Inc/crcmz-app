package me.crcmz.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.NotificationManager
import android.app.PictureInPictureParams
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * The CRCMZ app: app.crcmz.me/app in a web view, with native parts where the web can't
 * keep up on a phone, the same split as the iOS app (ios/):
 *
 *   tab bar + More          Shell.kt        ← frontend/src/lib/nativeShell.ts
 *   Huddle / Watch calls     NativeCall.kt   ← frontend/src/lib/nativeCall.ts
 *   Slap music               NativeAudio.kt  ← frontend/src/lib/nativeAudio.ts
 *   notifications + rings    MessagingService.kt (every alert is FCM: a web view gets no Web Push)
 *
 * The page talks to the app exactly as it does on iOS: window.webkit.messageHandlers.<name>
 * .postMessage(m). Here that's a small script at document start that forwards to a
 * WebMessageListener only app.crcmz.me can reach. The app answers with window.__crcmz*.
 *
 * Before the first load it asks once for notification permission, gets the FCM token
 * (handed to the page as ?crcmz_app=android-app&crcmz_fcm=…), and walks through the two
 * settings a ring needs (full-screen notifications, no battery limits).
 */
class LauncherActivity : AppCompatActivity() {
    lateinit var web: WebView
        private set
    private lateinit var refresh: SwipeRefreshLayout
    private lateinit var content: LinearLayout
    lateinit var root: FrameLayout
        private set
    private lateinit var shell: Shell
    private lateinit var calls: CallOverlay
    private var loaded = false
    private var pendingUrl: String? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null
    private var fullscreen: View? = null
    private var fullscreenDone: WebChromeClient.CustomViewCallback? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        val uris = when {
            r.resultCode != RESULT_OK -> null
            data?.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
            data?.data != null -> arrayOf(data.data!!)
            else -> null
        }
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private val askMedia = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val req = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        val ok = req.resources.filter {
            (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && granted[Manifest.permission.CAMERA] != false) ||
                (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && granted[Manifest.permission.RECORD_AUDIO] != false)
        }
        if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
    }

    private var permissionsDone: ((Set<String>) -> Unit)? = null
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        val done = permissionsDone ?: return@registerForActivityResult
        permissionsDone = null
        done(r.filterValues { it }.keys + r.keys.filter { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED })
    }

    /** Ask for what's missing (camera, mic), then hand back what's granted. */
    fun withPermissions(perms: List<String>, done: (Set<String>) -> Unit) {
        val missing = perms.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return done(perms.toSet())
        permissionsDone = { got -> done(perms.filter { it in got || checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }.toSet()) }
        askPermissions.launch(missing.toTypedArray())
    }

    private var screenDone: ((Intent?) -> Unit)? = null
    private val askScreen = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val done = screenDone ?: return@registerForActivityResult
        screenDone = null
        done(if (r.resultCode == RESULT_OK) r.data else null)
    }

    /** Android's "start recording or casting?" prompt, for sharing the screen in a call. */
    fun askScreenCapture(done: (Intent?) -> Unit) {
        val mpm = getSystemService(android.media.projection.MediaProjectionManager::class.java) ?: return done(null)
        screenDone = done
        askScreen.launch(mpm.createScreenCaptureIntent())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = getColor(R.color.bg)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.bg))
        refresh = SwipeRefreshLayout(this).apply {
            // MATCH_PARENT, never the default wrap_content: a wrap_content web view reports a
            // viewport height of 0, so every vh / dvh on the page collapses (the chat board
            // opened 0px tall).
            addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            setOnRefreshListener { web.reload(); postDelayed({ isRefreshing = false }, 800) }
            setProgressBackgroundColorSchemeColor(getColor(R.color.bg))
            setColorSchemeColors(getColor(R.color.accent))
            // Only from the very top: a page that scrolls inside itself keeps its own pull.
            setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }
        }
        shell = Shell(this) { path -> go(path) }
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(refresh, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(shell.bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.bg))
            addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        calls = CallOverlay(this, root)
        setContentView(root)
        // The page draws under the status bar (viewport-fit=cover reads it as a safe area);
        // the native bar sits above the gesture bar.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            // The keyboard covers the page (edge to edge, nothing resizes by itself): make the
            // page end where the keyboard starts, and the tab bar steps aside meanwhile, so
            // what you type sits right on the keyboard.
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val typing = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime > 0
            shell.keyboard = typing
            shell.bar.updatePadding(bottom = bars.bottom)
            content.updatePadding(bottom = if (typing) ime else 0)
            // The page's own fullscreen (the Watch Party) sits over everything: same there.
            val lift = if (typing) ime else 0
            (fullscreen?.layoutParams as? FrameLayout.LayoutParams)?.takeIf { it.bottomMargin != lift }?.let {
                it.bottomMargin = lift
                fullscreen?.layoutParams = it
            }
            refresh.updatePadding(top = bars.top, bottom = if (shell.bar.visibility == View.VISIBLE || typing) 0 else bars.bottom)
            calls.insets(bars.top, bars.bottom)
            insets
        }
        // The space for the status bar and the tab bar is made here, natively. Newer web views
        // (Chrome 135+) would also hand the bars' sizes to the page as env(safe-area-inset-*),
        // and the page would make the same room again: the header pushed down, the chat board
        // lifted off the tab bar. The page gets no insets at all, on every web view version.
        ViewCompat.setOnApplyWindowInsetsListener(refresh) { _, _ -> WindowInsetsCompat.CONSUMED }

        setUpWeb()
        NativeAudio.start(this)
        NativeCall.onEnded = { kind -> js("window.__crcmzCallEnded && window.__crcmzCallEnded('$kind')") }
        NativeCall.onData = { kind, payload, from, fromId ->
            val q = { v: String -> JSONObject.quote(v) }
            js("window.__crcmzCallData && window.__crcmzCallData(${q(kind)}, $payload, ${q(from)}, ${q(fromId)})")
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    fullscreen != null -> fullscreenDone?.onCustomViewHidden()
                    calls.back() -> Unit
                    web.canGoBack() -> web.goBack()
                    else -> moveTaskToBack(true)
                }
            }
        })

        pendingUrl = target(intent)
        // Ring-accept: join the LiveKit room immediately, before the page loads.
        intent.getStringExtra(EXTRA_AUTO_JOIN_ROOM)?.let { room -> NativeCall.autoJoin(this, room) }
        startUp()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWeb() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            userAgentString = "$userAgentString CRCMZ-Android/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        // Debug builds only: inspect the page from a computer (chrome://inspect).
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        // Passkeys in the page (sign-in and Settings → Passkeys), through the phone's
        // credential manager. crcmz.me vouches for this app (/.well-known/assetlinks.json).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(web.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "crcmzBridge", setOf(ORIGIN)) { _, message, origin, isMainFrame, _ ->
                if (!isMainFrame || origin.toString().trimEnd('/') != ORIGIN) return@addWebMessageListener
                val m = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
                val body = m.optJSONObject("m") ?: return@addWebMessageListener
                when (m.optString("h")) {
                    "crcmzShell" -> shell.update(body)
                    "crcmzCall" -> NativeCall.handle(this, body)
                    "crcmzAudio" -> NativeAudio.handle(body)
                }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, BRIDGE_JS, setOf(ORIGIN))
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (!req.isForMainFrame) return false
                val u = req.url
                if (u.scheme == "https" && u.host in HOSTS) return false
                openOutside(u)
                return true
            }

            // A video shared from Photos, for the page's Send a video (SharedFiles).
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): android.webkit.WebResourceResponse? =
                if (req.url.host == "app.crcmz.me") SharedFiles.serve(req.url.path.orEmpty()) else null

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                shell.pageChanged(url?.let(Uri::parse))
            }

            override fun onPageFinished(view: WebView, url: String?) {
                shell.pageChanged(url?.let(Uri::parse))
                CookieManager.getInstance().flush()
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                // The page died in the background (memory): bring it back rather than crash.
                recreate()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.origin.host != "app.crcmz.me") return request.deny()
                val need = mutableListOf<String>()
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources) need += Manifest.permission.CAMERA
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources) need += Manifest.permission.RECORD_AUDIO
                val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) {
                    request.grant(request.resources.filter {
                        it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    }.toTypedArray())
                } else {
                    pendingPermission = request
                    askMedia.launch(missing.toTypedArray())
                }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickFiles.launch(params.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE))
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            // A video's own fullscreen (the Watch Party player, trailers).
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                fullscreen?.let { root.removeView(it) }
                fullscreen = view
                fullscreenDone = callback
                root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                ViewCompat.requestApplyInsets(root)
                WindowInsetsControllerCompat(window, window.decorView).apply {
                    hide(WindowInsetsCompat.Type.systemBars())
                    systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            }

            override fun onHideCustomView() {
                fullscreen?.let { root.removeView(it) }
                fullscreen = null
                fullscreenDone = null
                WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
            }

            // target=_blank: CRCMZ pages open here, anything else outside.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                val probe = WebView(this@LauncherActivity)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                        val u = req.url
                        if (u.scheme == "https" && u.host in HOSTS) web.loadUrl(u.toString()) else openOutside(u)
                        probe.destroy()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }
        }
    }

    // MARK: Opening pages

    /** The page a launch, a notification, a ring, a link, a shortcut or a share asks for. */
    private fun target(i: Intent?): String? {
        i ?: return null
        if (i.action == Intent.ACTION_SEND && i.type.orEmpty().startsWith("video/")) {
            @Suppress("DEPRECATION")
            val uri = (if (android.os.Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                       else i.getParcelableExtra(Intent.EXTRA_STREAM)) ?: return null
            return SharedFiles.offer(this, uri, i.type.orEmpty())
        }
        if (i.action == Intent.ACTION_SEND && i.type == "text/plain") {
            val text = i.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            val link = Regex("https?://\\S+").find(text)?.value.orEmpty()
            // /app/share sends a song (Spotify, Apple Music…) to Slap, anything else to the Watch Party.
            return Uri.parse("$ORIGIN/app/share").buildUpon()
                .appendQueryParameter("url", link)
                .appendQueryParameter("text", text)
                .appendQueryParameter("title", i.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty())
                .build().toString()
        }
        val d = i.data ?: i.getStringExtra(EXTRA_PATH)?.let { Ringer.appUri(it) } ?: return null
        return if (d.scheme == "https" && d.host == "app.crcmz.me" && d.path.orEmpty().startsWith("/app")) d.toString() else null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Ring-accept while app is already running: join the room before processing the URL.
        intent.getStringExtra(EXTRA_AUTO_JOIN_ROOM)?.let { room -> NativeCall.autoJoin(this, room) }
        val url = target(intent) ?: return
        if (!loaded) { pendingUrl = url; return }
        val u = Uri.parse(url)
        val inApp = web.url?.let(Uri::parse)?.let { it.host == "app.crcmz.me" && it.path.orEmpty().startsWith("/app") } == true
        // Already in the app: route in place so calls and music keep going.
        if (inApp && u.query == null) go(u.path!!.removePrefix("/app").ifEmpty { "/" }) else web.loadUrl(url)
    }

    /** Route the page in place (client-side), like a tap on its own tab bar. */
    fun go(path: String) {
        val p = JSONObject.quote(path)
        js("window.__crcmzGo ? window.__crcmzGo($p) : location.assign('/app' + $p)")
    }

    fun js(code: String) {
        if (::web.isInitialized) web.post { web.evaluateJavascript(code, null) }
    }

    private fun openOutside(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) { /* nothing on this phone opens it */ }
    }

    fun setBarVisible(show: Boolean) {
        shell.bar.visibility = if (show) View.VISIBLE else View.GONE
        ViewCompat.requestApplyInsets(root)
    }

    // MARK: First launch: notifications, the FCM token, ring setup

    private fun startUp() {
        val prefs = Push.prefs(this)
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean(ASKED, false) &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            prefs.edit().putBoolean(ASKED, true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            return
        }
        withToken()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code == 1) withToken()
    }

    private var inSettings = false

    override fun onResume() {
        super.onResume()
        if (inSettings) {
            inSettings = false
            setup()
        }
    }

    /** The first launch waits up to 2.5s for a token; after that it's cached. */
    private fun withToken() {
        if (Push.token(this) != null) return next()
        val timeout = Handler(Looper.getMainLooper())
        timeout.postDelayed({ next() }, 2500)
        FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
            if (t.isSuccessful && t.result != null) Push.save(this, t.result)
            timeout.removeCallbacksAndMessages(null)
            next()
        }
    }

    private var settingUp = false
    private fun next() {
        if (settingUp || loaded || isFinishing) return
        settingUp = true
        setup()
    }

    /** The next ring setting still to ask about (each asked once, ever), then load. */
    @SuppressLint("BatteryLife")
    private fun setup() {
        val prefs = Push.prefs(this)
        val nm = getSystemService(NotificationManager::class.java)
        val pm = getSystemService(PowerManager::class.java)
        val step = when {
            Build.VERSION.SDK_INT >= 34 && !prefs.getBoolean(ASKED_FSI, false) && !nm.canUseFullScreenIntent() ->
                Triple(ASKED_FSI, R.string.setup_fsi,
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            !prefs.getBoolean(ASKED_BATTERY, false) && !pm.isIgnoringBatteryOptimizations(packageName) ->
                Triple(ASKED_BATTERY, R.string.setup_battery,
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            else -> return load()
        }
        prefs.edit().putBoolean(step.first, true).apply()
        AlertDialog.Builder(this)
            .setTitle(R.string.setup_title)
            .setMessage(step.second)
            .setCancelable(false)
            .setPositiveButton(R.string.setup_go) { _, _ ->
                try {
                    inSettings = true
                    startActivity(step.third)
                } catch (_: Exception) {
                    inSettings = false
                    setup()
                }
            }
            .setNegativeButton(R.string.setup_skip) { _, _ -> setup() }
            .show()
    }

    private fun load() {
        if (loaded) return
        loaded = true
        val start = Uri.parse(pendingUrl ?: "$ORIGIN/app").buildUpon().appendQueryParameter("crcmz_app", "android-app")
        Push.token(this)?.let { start.appendQueryParameter("crcmz_fcm", it) }
        pendingUrl = null
        web.loadUrl(start.build().toString())
    }

    // MARK: Picture in picture (a call on screen when you leave the app)

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT in 26..30 && NativeCall.wantsPip()) enterPip()
    }

    fun pipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < 26) return null
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16))
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(NativeCall.wantsPip()).setSeamlessResizeEnabled(true)
        return b.build()
    }

    /** Called when the call starts, stops or changes size: Android 12+ floats it by itself. */
    fun updatePip() {
        if (Build.VERSION.SDK_INT >= 26) pipParams()?.let { runCatching { setPictureInPictureParams(it) } }
    }

    fun enterPip() {
        if (Build.VERSION.SDK_INT >= 26) pipParams()?.let { runCatching { enterPictureInPictureMode(it) } }
    }

    override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(inPip, newConfig)
        content.visibility = if (inPip) View.INVISIBLE else View.VISIBLE
        calls.pip(inPip)
    }

    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }

    companion object {
        const val ORIGIN = "https://app.crcmz.me"
        const val EXTRA_PATH = "path"
        private val HOSTS = setOf("app.crcmz.me", "auth.crcmz.me")
        private const val ASKED = "asked_notifications"
        private const val ASKED_FSI = "asked_full_screen"
        private const val ASKED_BATTERY = "asked_battery"

        /** The running app, for the call and music services to talk to the page. */
        var current: LauncherActivity? = null
            private set

        /**
         * Intent extra carrying a Huddle room name to auto-join on ring-accept.
         * Set by [RingActivity] when the user taps Accept; consumed once by [onCreate] /
         * [onNewIntent] to trigger [NativeCall.autoJoin] before the page loads.
         */
        const val EXTRA_AUTO_JOIN_ROOM = "auto_join_room"

        /** window.webkit.messageHandlers.* as on iOS, forwarded to crcmzBridge. */
        private val BRIDGE_JS = """
            (function () {
              if (!window.crcmzBridge || (window.webkit && window.webkit.messageHandlers)) return;
              var h = function (name) { return { postMessage: function (m) { crcmzBridge.postMessage(JSON.stringify({ h: name, m: m })) } } };
              window.webkit = { messageHandlers: { crcmzShell: h('crcmzShell'), crcmzCall: h('crcmzCall'), crcmzAudio: h('crcmzAudio') } };
            })();
        """.trimIndent()
    }
}
