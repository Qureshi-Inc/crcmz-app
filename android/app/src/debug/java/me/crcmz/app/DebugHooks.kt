package me.crcmz.app

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView

/** adb shell am broadcast -a me.crcmz.app.DEBUG_LIVE -p me.crcmz.app --es key watch:crcmz --es kind watch ...
 *  Every extra becomes a field of the FCM "live" message (debug builds only). */
class DebugLiveReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val d = intent.extras?.keySet()?.associateWith { intent.extras?.get(it)?.toString().orEmpty() } ?: return
        // --es hide <key>: what tapping the notification's Hide does.
        d["hide"]?.let { LiveUpdates.HideReceiver().onReceive(ctx, Intent().putExtra("key", it)); return }
        // Off the main thread, as FCM delivers it (the artwork is fetched while building).
        val pending = goAsync()
        Thread { try { LiveUpdates.handle(ctx, d + ("type" to "live")) } finally { pending.finish() } }.start()
    }
}

/** The three widgets, drawn with sample data, for screenshots (debug builds only). Slap is
 *  drawn twice: playing, then with nothing loaded (the last song and Resume). */
class DebugWidgetsActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Push.prefs(this).edit().putString("widget_summary", SAMPLE).putBoolean("widget_signed_out", false).apply()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 120, 40, 40); setBackgroundColor(0xFF2B2F3A.toInt()) }
        fun add(v: android.widget.RemoteViews, h: Int) {
            val view = v.apply(this, col)
            col.addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, h).apply { bottomMargin = 40 })
        }
        add(WidgetData.liveViews(this), 525)
        Thread {
            val cover = runCatching { java.net.URL("https://images.metahub.space/poster/small/tt0133093/img").readBytes() }.getOrNull()
            val movies = WidgetData.movieViews(this)
            NativeAudio.snapshot = NativeAudio.Now("Digits", "Young Thug", cover, true)
            val playing = SlapWidget.views(this)
            NativeAudio.snapshot = null
            SlapWidget.remember(this, "Money Trees", "Kendrick Lamar", cover)
            val idle = SlapWidget.views(this)
            runOnUiThread { add(movies, 640); add(playing, 360); add(idle, 360) }
        }.start()
        setContentView(ScrollView(this).apply { addView(col) })
    }
    companion object {
        val SAMPLE = """{"live":[
          {"key":"watch:crcmz","kind":"watch","title":"Dune: Part Two","subtitle":"4 watching · moiz, Moose, Noor +1","progress":0.42,"progressLabel":"70 of 166 min","url":"/app/watch/party"},
          {"key":"slap:together","kind":"slap","title":"Digits · Young Thug","subtitle":"3 listening · ASamad89, mutasif, moiz","progress":0.6,"progressLabel":"1:52 / 3:07","url":"/app/slap?join=together"},
          {"key":"tourney:t1","kind":"tourney","title":"FC 27 Cup","subtitle":"8 players · 5 of 12 matches played","progress":0.41,"progressLabel":"Match 6 of 12","url":"/app/tourney/t1"}],
          "continue":[
          {"title":"Oppenheimer","poster":"https://images.metahub.space/poster/medium/tt15398776/img","url":"/app/watch?resume=x","progress":0.35,"left":"117 min left"}],
          "movies":[
          {"title":"Dune: Part Two","poster":"https://images.metahub.space/poster/medium/tt15239678/img","url":"/app/watch?m=tt15239678"},
          {"title":"Interstellar","poster":"https://images.metahub.space/poster/medium/tt0816692/img","url":"/app/watch?m=tt0816692"},
          {"title":"The Dark Knight","poster":"https://images.metahub.space/poster/medium/tt0468569/img","url":"/app/watch?m=tt0468569"},
          {"title":"The Matrix","poster":"https://images.metahub.space/poster/medium/tt0133093/img","url":"/app/watch?m=tt0133093"}]}"""
    }
}
