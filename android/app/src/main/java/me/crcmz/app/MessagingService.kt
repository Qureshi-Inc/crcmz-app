package me.crcmz.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM data messages from the server (fcm.py). Only rings come this way; every other
 * notification is Web Push, which Chrome hands to DelegationService.
 */
class MessagingService : FirebaseMessagingService() {
    // A rotated token reaches the server on the next launch (see LauncherActivity).
    override fun onNewToken(token: String) = Push.save(this, token)

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        when (d["type"]) {
            "ring" -> Ringer.ring(this, d)
            "ring_cancel" -> d["tag"]?.let { Ringer.cancel(this, it) }
        }
    }
}
