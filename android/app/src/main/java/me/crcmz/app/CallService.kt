package me.crcmz.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat

/**
 * Keeps a Huddle or Watch Party call going with the app in the background (Android stops
 * the mic and camera of a backgrounded app otherwise), with the ongoing-call notification:
 * tap to go back, Leave to hang up.
 */
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_LEAVE) {
            NativeCall.leave()
            stopSelf()
            return START_NOT_STICKY
        }
        if (!NativeCall.live()) { stopSelf(); return START_NOT_STICKY }
        channel(this)
        var type = 0
        if (Build.VERSION.SDK_INT >= 30) {
            if (has(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (NativeCall.camOn && has(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            if (type == 0) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        }
        try {
            ServiceCompat.startForeground(this, ID, notification(), type)
        } catch (e: Exception) {
            android.util.Log.w("crcmz", "call service", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun notification(): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
        val leave = PendingIntent.getService(this, 1, Intent(this, CallService::class.java).setAction(ACTION_LEAVE), flags)
        val who = Person.Builder().setName(NativeCall.title.ifEmpty { "CRCMZ" }).setImportant(true).build()
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(NativeCall.title)
            .setContentText(getString(R.string.call_ongoing))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(open)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(who, leave))
            .build()
    }

    companion object {
        private const val CHANNEL = "call_v1"
        private const val ID = 4242
        private const val ACTION_LEAVE = "me.crcmz.app.LEAVE_CALL"
        private var running = false

        private fun channel(ctx: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, ctx.getString(R.string.call_channel), NotificationManager.IMPORTANCE_LOW))
        }

        /** Start or stop with the call (NativeCall calls this on every change). */
        fun sync() {
            val ctx = LauncherActivity.current ?: return
            val want = NativeCall.live()
            if (want) {
                try { ctx.startService(Intent(ctx, CallService::class.java)); running = true } catch (_: Exception) { }
            } else if (running) {
                running = false
                ctx.stopService(Intent(ctx, CallService::class.java))
            }
        }
    }
}
