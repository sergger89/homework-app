package com.homeworkapp.client

import android.content.Context

object ServerConfig {
    private const val PREFS = "homework_app_prefs"
    private const val KEY_URL = "server_url"

    fun getUrl(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getString(KEY_URL, null)
    }

    fun setUrl(context: Context, url: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_URL, url).apply()
    }
}
