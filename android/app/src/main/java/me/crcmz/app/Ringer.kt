package me.crcmz.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * A Huddle or Watch Party starting rings like a phone call: the system call
 * notification (Join / Decline), full screen over the lock screen, ringtone on
 * loop for up to RING_MS. Join opens the page the server named.
 */
object Ringer {
    const val EXTRA_TAG = "tag"
    const val RING_MS = 30_000L
    private const val CHANNEL = "ring_v1"
    private const val ORIGIN = "https://app.crcmz.me"

    fun id(tag: String) = tag.hashCode()

    /** Only ever a page of this app, whatever the payload says (same rule as sw.js). */
    fun appUri(path: String?): Uri {
        val p = path.orEmpty()
        return Uri.parse(ORIGIN + if (p.startsWith("/app") && !p.contains("//")) p else "/app")
    }

    private fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val ch = NotificationChannel(CHANNEL, ctx.getString(R.string.ring_channel), NotificationManager.IMPORTANCE_HIGH).apply {
            description = ctx.getString(R.string.ring_channel_desc)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 600, 800)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    fun ring(ctx: Context, d: Map<String, String>) {
        val tag = d["tag"] ?: "ring"
        val title = d["title"] ?: "CRCMZ"
        val body = d["body"].orEmpty()
        val caller = d["caller"]?.takeIf { it.isNotBlank() } ?: title
        val url = appUri(d["url"]).toString()
        val n = id(tag)
        channel(ctx)

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val screen = PendingIntent.getActivity(ctx, n, RingActivity.ringing(ctx, tag, title, body, url), flags)
        val join = PendingIntent.getActivity(ctx, n + 1, RingActivity.joining(ctx, tag, url), flags)
        val decline = PendingIntent.getBroadcast(
            ctx, n + 2, Intent(ctx, DeclineReceiver::class.java).putExtra(EXTRA_TAG, tag), flags,
        )
        val who = Person.Builder().setName(caller).setImportant(true).build()

        val notification = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
            .setVibrate(longArrayOf(0, 800, 600, 800))
            .setOngoing(true)
            .setTimeoutAfter(RING_MS)
            .setContentIntent(screen)
            .setFullScreenIntent(screen, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(who, decline, join))
            .build()
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        try {
            NotificationManagerCompat.from(ctx).notify(n, notification)
        } catch (_: SecurityException) {
            // Notifications are off for the app: nothing to ring.
        }
    }

    fun cancel(ctx: Context, tag: String) {
        NotificationManagerCompat.from(ctx).cancel(id(tag))
        RingActivity.close(tag)
    }
}
