package me.crcmz.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Decline on the ring notification: stop ringing, nothing else. */
class DeclineReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        intent.getStringExtra(Ringer.EXTRA_TAG)?.let { Ringer.cancel(ctx, it) }
    }
}
