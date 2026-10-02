package me.crcmz.app

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.TextView

/** The full-screen ring (title, Join, Decline), and the Join action itself. */
class RingActivity : Activity() {
    private var tag = ""
    private val timeout = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(i: Intent) {
        tag = i.getStringExtra(Ringer.EXTRA_TAG).orEmpty()
        val url = i.getStringExtra(EXTRA_URL).orEmpty()
        if (i.action == ACTION_JOIN) return join(url)

        if (Build.VERSION.SDK_INT < 27) {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.ring)
        findViewById<TextView>(R.id.ring_title).text = i.getStringExtra(EXTRA_TITLE)
        findViewById<TextView>(R.id.ring_body).text = i.getStringExtra(EXTRA_BODY)
        findViewById<TextView>(R.id.ring_join).setOnClickListener { join(url) }
        findViewById<TextView>(R.id.ring_decline).setOnClickListener { Ringer.cancel(this, tag); finish() }
        showing = this
        timeout.removeCallbacksAndMessages(null)
        timeout.postDelayed({ finish() }, Ringer.RING_MS)
    }

    /** Stop ringing, unlock if needed, then open the Huddle / party in the app. */
    private fun join(url: String) {
        Ringer.cancel(this, tag)
        val open = {
            startActivity(
                Intent(this, LauncherActivity::class.java)
                    .setAction(Intent.ACTION_VIEW)
                    .setData(Uri.parse(url)) // already checked by Ringer.appUri
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            finish()
        }
        val km = getSystemService(KeyguardManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && km.isKeyguardLocked) {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = open()
                override fun onDismissCancelled() = finish()
                override fun onDismissError() = finish()
            })
        } else {
            open()
        }
    }

    override fun onDestroy() {
        timeout.removeCallbacksAndMessages(null)
        if (showing === this) showing = null
        super.onDestroy()
    }

    companion object {
        private const val ACTION_JOIN = "me.crcmz.app.JOIN"
        private const val EXTRA_URL = "url"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"
        private var showing: RingActivity? = null

        fun ringing(ctx: Context, tag: String, title: String, body: String, url: String): Intent =
            Intent(ctx, RingActivity::class.java)
                .putExtra(Ringer.EXTRA_TAG, tag).putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body).putExtra(EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun joining(ctx: Context, tag: String, url: String): Intent =
            Intent(ctx, RingActivity::class.java).setAction(ACTION_JOIN)
                .putExtra(Ringer.EXTRA_TAG, tag).putExtra(EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        /** Declined, answered or cancelled elsewhere: drop the full-screen ring too. */
        fun close(tag: String) {
            showing?.takeIf { it.tag == tag }?.finish()
        }
    }
}
