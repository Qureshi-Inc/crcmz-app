package me.crcmz.app

import android.content.Context
import android.content.SharedPreferences

/** This phone's FCM token, cached for the launcher to hand to the page. */
object Push {
    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences("crcmz", Context.MODE_PRIVATE)
    fun token(ctx: Context): String? = prefs(ctx).getString("fcm", null)
    fun save(ctx: Context, token: String) = prefs(ctx).edit().putString("fcm", token).apply()
}
