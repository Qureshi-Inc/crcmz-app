package me.crcmz.app

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Opens app.crcmz.me/app in Chrome as a Trusted Web Activity (no URL bar).
 *
 * Before launching it asks once for notification permission (rings and Web Push
 * both need it) and makes sure there's an FCM token, which rides along on the
 * launch URL as ?crcmz_app=android&crcmz_fcm=… so the signed-in page can register
 * this phone for rings (frontend/src/lib/native.ts → /api/push/native).
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

    /** The first launch waits up to 2.5s for a token; after that it's cached. */
    private fun withToken() {
        if (Push.token(this) != null) return go()
        val timeout = Handler(Looper.getMainLooper())
        timeout.postDelayed({ go() }, 2500)
        FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
            if (t.isSuccessful && t.result != null) Push.save(this, t.result)
            timeout.removeCallbacksAndMessages(null)
            go()
        }
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
    }
}
