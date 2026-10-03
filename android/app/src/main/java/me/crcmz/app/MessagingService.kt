package me.crcmz.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM data messages from the server (fcm.py): rings (Ringer) and, since this app is a web
 * view with no Web Push, every other notification too (Squad Up, clips, @mentions,
 * movies…). Tapping one opens the page it names.
 */
class MessagingService : FirebaseMessagingService() {
    // A rotated token reaches the server on the next launch (see LauncherActivity).
    override fun onNewToken(token: String) = Push.save(this, token)

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        when (d["type"]) {
            "ring" -> Ringer.ring(this, d)
            "ring_cancel" -> d["tag"]?.let { Ringer.cancel(this, it) }
            "alert" -> alert(this, d)
        }
    }

    companion object {
        private const val CHANNEL = "alerts_v1"

        fun alert(ctx: Context, d: Map<String, String>) {
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
                    NotificationChannel(CHANNEL, ctx.getString(R.string.alert_channel), NotificationManager.IMPORTANCE_HIGH))
            }
            val tag = d["tag"] ?: d["category"] ?: "crcmz"
            val open = PendingIntent.getActivity(ctx, tag.hashCode(),
                Intent(ctx, LauncherActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Ringer.appUri(d["url"]))
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val n = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(ctx.getColor(R.color.accent))
                .setContentTitle(d["title"] ?: "CRCMZ")
                .setContentText(d["body"].orEmpty())
                .setStyle(NotificationCompat.BigTextStyle().bigText(d["body"].orEmpty()))
                .setAutoCancel(true)
                .setContentIntent(open)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setGroup(d["category"])
                .build()
            try {
                NotificationManagerCompat.from(ctx).notify(tag, 0, n)
            } catch (_: SecurityException) { /* notifications are off for the app */ }
        }
    }
}
