package com.homeworkapp.client

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        toolbar.title = getString(R.string.settings_title)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(ServerConfig.getUrl(this) != null)
        toolbar.setNavigationOnClickListener { finish() }

        val urlLayout = findViewById<TextInputLayout>(R.id.urlInputLayout)
        val urlEditText = findViewById<TextInputEditText>(R.id.urlEditText)
        val saveButton = findViewById<android.widget.Button>(R.id.saveButton)

        ServerConfig.getUrl(this)?.let { urlEditText.setText(it) }

        saveButton.setOnClickListener {
            val raw = urlEditText.text?.toString()?.trim().orEmpty()
            urlLayout.error = null

            if (raw.isEmpty()) {
                urlLayout.error = getString(R.string.settings_error_empty)
                return@setOnClickListener
            }
            if (!raw.startsWith("https://")) {
                urlLayout.error = getString(R.string.settings_error_https)
                return@setOnClickListener
            }

            val normalized = raw.trimEnd('/')
            ServerConfig.setUrl(this, normalized)
            Toast.makeText(this, "Сохранено", Toast.LENGTH_SHORT).show()
            finish()
        }
    }
}
