package me.crcmz.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray

/**
 * Live updates (live.py on the server): a Watch Party, Huddle, Slap's Listen Together or a
 * tournament going on, as an ongoing notification for whoever turned it on in Settings.
 * FCM data {type: live, event: start|update|end, key, kind, title, body, count, started,
 * progress (-1 none, else 0..1), progressLabel, paused, url, segments}.
 *
 * Android 16+: a Live Update. ProgressStyle (a bar through the film or song, or one segment
 * per tournament match), promoted to the lock screen and a status-bar chip. Older phones:
 * an ongoing notification with a bar, or a "live for" clock. "Hide" keeps it away until
 * that session ends.
 */
object LiveUpdates {
    private const val CHANNEL = "live_v1"
    private const val HIDDEN = "live_hidden"

    fun handle(ctx: Context, d: Map<String, String>) {
        val key = d["key"] ?: return
        val nm = NotificationManagerCompat.from(ctx)
        if (d["event"] == "end") {
            nm.cancel(key, 0)
            hidden(ctx).remove(key).also { save(ctx) }
            return
        }
        if (key in hidden(ctx)) return
        channel(ctx)
        val n = if (Build.VERSION.SDK_INT >= 36) modern(ctx, d) else compat(ctx, d)
        try {
            nm.notify(key, 0, n)
        } catch (_: SecurityException) { /* notifications are off for the app */ }
    }

    private fun icon(kind: String?) = when (kind) {
        "watch" -> R.drawable.ic_watch
        "huddle" -> R.drawable.ic_huddle
        "slap" -> R.drawable.ic_slap
        else -> R.drawable.ic_trophy
    }

    private fun emoji(kind: String?) = when (kind) {
        "watch" -> "📺"; "huddle" -> "🎧"; "slap" -> "🎵"; else -> "🏆"
    }

    /** The status-bar chip: short. "3 👀", "2 in the call", "Match 4/12". */
    private fun chip(d: Map<String, String>): String {
        val count = d["count"]?.toIntOrNull() ?: 0
        return when (d["kind"]) {
            "tourney" -> d["progressLabel"]?.replace("Match ", "")?.replace(" of ", "/")?.let { "🏆 $it" } ?: "🏆 Live"
            else -> "${emoji(d["kind"])} $count"
        }
    }

    private fun open(ctx: Context, d: Map<String, String>): PendingIntent = PendingIntent.getActivity(
        ctx, (d["key"] ?: "live").hashCode(),
        Intent(ctx, LauncherActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Ringer.appUri(d["url"]))
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun hide(ctx: Context, key: String): PendingIntent = PendingIntent.getBroadcast(
        ctx, key.hashCode() + 1, Intent(ctx, HideReceiver::class.java).putExtra("key", key),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun body(d: Map<String, String>): String =
        listOfNotNull(d["body"]?.takeIf { it.isNotBlank() }, d["progressLabel"]?.takeIf { it.isNotBlank() }).joinToString(" · ")

    @SuppressLint("NewApi")
    private fun modern(ctx: Context, d: Map<String, String>): Notification {
        val progress = d["progress"]?.toDoubleOrNull() ?: -1.0
        val started = d["started"]?.toLongOrNull() ?: System.currentTimeMillis()
        val accent = ctx.getColor(R.color.accent)
        val b = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(icon(d["kind"]))
            .setContentTitle(d["title"] ?: "CRCMZ")
            .setContentText(body(d))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open(ctx, d))
            // "Promote me" (a Live Update): the extra AndroidX's setRequestPromotedOngoing sets;
            // the platform has no public setter for it in API 36.
            .addExtras(android.os.Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
            .setShortCriticalText(chip(d))
            .setWhen(started)
            .addAction(Notification.Action.Builder(null, ctx.getString(R.string.live_hide), hide(ctx, d["key"]!!)).build())
        val segs = runCatching { JSONArray(d["segments"] ?: "[]") }.getOrNull()
        if (segs != null && segs.length() > 0) {
            // A tournament: one segment per match, filled as they're played.
            val style = Notification.ProgressStyle()
                .setProgressSegments((0 until segs.length()).map { Notification.ProgressStyle.Segment(1).setColor(accent) })
                .setProgress(((progress.coerceIn(0.0, 1.0)) * segs.length()).toInt())
                .setStyledByProgress(true)
                .setProgressTrackerIcon(Icon.createWithResource(ctx, icon(d["kind"])))
            b.setStyle(style)
        } else if (progress >= 0) {
            val style = Notification.ProgressStyle()
                .setProgressSegments(listOf(Notification.ProgressStyle.Segment(1000).setColor(accent)))
                .setProgress((progress.coerceIn(0.0, 1.0) * 1000).toInt())
                .setStyledByProgress(true)
                .setProgressTrackerIcon(Icon.createWithResource(ctx, icon(d["kind"])))
            b.setStyle(style)
        } else {
            b.setUsesChronometer(true).setShowWhen(true)   // a Huddle: "live for 12:34"
        }
        return b.build()
    }

    private fun compat(ctx: Context, d: Map<String, String>): Notification {
        val progress = d["progress"]?.toDoubleOrNull() ?: -1.0
        val started = d["started"]?.toLongOrNull() ?: System.currentTimeMillis()
        val b = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(icon(d["kind"]))
            .setColor(ctx.getColor(R.color.accent))
            .setContentTitle(d["title"] ?: "CRCMZ")
            .setContentText(body(d))
            .setSubText(chip(d))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open(ctx, d))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setWhen(started)
            .addAction(0, ctx.getString(R.string.live_hide), hide(ctx, d["key"]!!))
        if (progress >= 0) b.setProgress(1000, (progress.coerceIn(0.0, 1.0) * 1000).toInt(), false)
        else b.setUsesChronometer(true).setShowWhen(true)
        return b.build()
    }

    private fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        // Default importance, no sound: it sits there and updates, it doesn't ping.
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, ctx.getString(R.string.live_channel), NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            })
    }

    // Keys the person hid, until those sessions end.
    private var hiddenCache: MutableSet<String>? = null
    private fun hidden(ctx: Context): MutableSet<String> =
        hiddenCache ?: (Push.prefs(ctx).getStringSet(HIDDEN, emptySet())?.toMutableSet() ?: mutableSetOf()).also { hiddenCache = it }
    private fun save(ctx: Context) = Push.prefs(ctx).edit().putStringSet(HIDDEN, hidden(ctx).toSet()).apply()

    class HideReceiver : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val key = intent.getStringExtra("key") ?: return
            hidden(ctx).add(key)
            save(ctx)
            NotificationManagerCompat.from(ctx).cancel(key, 0)
        }
    }
}
