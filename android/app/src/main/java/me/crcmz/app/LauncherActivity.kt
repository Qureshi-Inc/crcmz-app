package me.crcmz.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Opens app.crcmz.me/app in Chrome as a Trusted Web Activity (no URL bar).
 *
 * Before launching it asks once for notification permission (rings and Web Push
 * both need it) and makes sure there's an FCM token, which rides along on the
 * launch URL as ?crcmz_app=android&crcmz_fcm=… so the signed-in page can register
 * this phone for rings (frontend/src/lib/native.ts → /api/push/native).
 *
 * Then, once each, the two settings a ring needs to behave like a call: full-screen
 * notifications (off by default since Android 14) and no battery restrictions (so Doze
 * doesn't hold a ring back). Either can be skipped; the app opens regardless.
 */
class LauncherActivity : com.google.androidbrowserhelper.trusted.LauncherActivity() {
    private var launched = false

    override fun shouldLaunchImmediately() = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (isFinishing) return
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
        withToken()
    }

    // Back from a settings screen: carry on with the next step, or launch.
    private var inSettings = false

    override fun onResume() {
        super.onResume()
        if (inSettings) {
            inSettings = false
            setup()
        }
    }

    /** The next ring setting still to ask about (each asked once, ever), or launch. */
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
            else -> return go()
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

    // The token timeout and the token itself can both arrive: set up once.
    private var settingUp = false
    private fun next() {
        if (settingUp || launched || isFinishing) return
        settingUp = true
        setup()
    }

    private fun go() {
        if (launched || isFinishing) return
        launched = true
        launchTwa()
    }

    override fun getLaunchingUrl(): Uri {
        val url = super.getLaunchingUrl()
        val token = Push.token(this) ?: return url
        return url.buildUpon()
            .appendQueryParameter("crcmz_app", "android")
            .appendQueryParameter("crcmz_fcm", token)
            .build()
    }

    private companion object {
        const val ASKED = "asked_notifications"
        const val ASKED_FSI = "asked_full_screen"
        const val ASKED_BATTERY = "asked_battery"
    }
}
