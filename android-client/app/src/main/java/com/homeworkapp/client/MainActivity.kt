package com.homeworkapp.client

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.provider.MediaStore
import android.view.Menu
import android.view.MenuItem
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var errorView: android.view.View
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null
    private var currentHost: String? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult

        if (result.resultCode != Activity.RESULT_OK) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data
        val results: Array<Uri>? = when {
            data?.clipData != null -> {
                // выбрано несколько файлов (галерея/файловый менеджер)
                val clip = data.clipData!!
                Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
            }
            data?.data != null -> arrayOf(data.data!!)
            cameraPhotoUri != null -> arrayOf(cameraPhotoUri!!)
            else -> null
        }
        callback.onReceiveValue(results)
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted) {
            Toast.makeText(this, "Без разрешения камеры доступна только галерея", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        errorView = findViewById(R.id.errorView)

        findViewById<android.widget.Button>(R.id.retryButton).setOnClickListener { loadServerUrl(force = true) }
        findViewById<android.widget.Button>(R.id.openSettingsButton).setOnClickListener { openSettings() }

        setupWebView()

        swipeRefresh.setOnRefreshListener { webView.reload() }

        // Мост, чтобы веб-страница сама могла временно отключать нативный "потяни вниз,
        // чтобы обновить" во время рисования в черновике/пролистывания книги - иначе
        // SwipeRefreshLayout перехватывает вертикальный жест на уровне Android ещё до того,
        // как до него доберётся JS на странице, и никакой preventDefault() там не поможет.
        webView.addJavascriptInterface(NativeGestureBridge(), "AndroidBridge")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportMultipleWindows(false)
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme
                if (scheme != "http" && scheme != "https") {
                    // mailto:, tel: и т.п. - отдаём системе
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        true
                    } catch (e: Exception) {
                        true
                    }
                }
                // всё в пределах настроенного сервера открываем внутри WebView;
                // остальное (внешние ссылки) - во внешнем браузере
                return if (currentHost != null && uri.host == currentHost) {
                    false
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false
                errorView.visibility = android.view.View.GONE
                swipeRefresh.visibility = android.view.View.VISIBLE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) showError()
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // безопасное поведение по умолчанию: не принимаем невалидный сертификат
                handler.cancel()
                showError()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCb: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback = filePathCb

                val allowMultiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                val acceptTypes = params.acceptTypes?.filter { it.isNotBlank() }?.toTypedArray() ?: emptyArray()

                val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (acceptTypes.size == 1) acceptTypes[0] else "*/*"
                    if (acceptTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
                    if (allowMultiple) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }

                val intents = mutableListOf<Intent>()

                // Добавляем "Сделать фото" как вариант, если запрашивается изображение (или любой тип)
                val wantsImage = acceptTypes.isEmpty() || acceptTypes.any { it.startsWith("image/") }
                if (wantsImage && hasCameraPermissionOrRequest()) {
                    createCameraIntent()?.let { intents.add(it) }
                }

                val chooser = Intent.createChooser(contentIntent, "Выберите файл").apply {
                    if (intents.isNotEmpty()) {
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, intents.toTypedArray())
                    }
                }

                return try {
                    fileChooserLauncher.launch(chooser)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }
    }

    private fun hasCameraPermissionOrRequest(): Boolean {
        val granted = ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            cameraPermissionLauncher.launch(android.Manifest.permission.CAMERA)
        }
        return granted
    }

    private fun createCameraIntent(): Intent? {
        return try {
            val photoDir = File(cacheDir, "camera").apply { mkdirs() }
            val photoFile = File.createTempFile("capture_", ".jpg", photoDir)
            cameraPhotoUri = FileProvider.getUriForFile(this, "$packageName.fileprovider", photoFile)
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    private fun showError() {
        swipeRefresh.visibility = android.view.View.GONE
        errorView.visibility = android.view.View.VISIBLE
        swipeRefresh.isRefreshing = false
    }

    private fun loadServerUrl(force: Boolean = false) {
        val url = ServerConfig.getUrl(this)
        if (url == null) {
            openSettings()
            return
        }
        currentHost = Uri.parse(url).host
        if (force || webView.url == null || Uri.parse(webView.url).host != currentHost) {
            errorView.visibility = android.view.View.GONE
            swipeRefresh.visibility = android.view.View.VISIBLE
            webView.loadUrl(url)
        }
    }

    override fun onResume() {
        super.onResume()
        loadServerUrl()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_settings -> { openSettings(); true }
            R.id.action_reload -> { webView.reload(); true }
            else -> super.onOptionsItemSelected(item)
        }
    }

    /**
     * Доступен на веб-странице как window.AndroidBridge.setDrawingActive(true/false).
     * Пока true - "потяни вниз, чтобы обновить" выключен, чтобы не перехватывать жест
     * рисования в черновике/пролистывания книги.
     */
    inner class NativeGestureBridge {
        @JavascriptInterface
        fun setDrawingActive(active: Boolean) {
            runOnUiThread { swipeRefresh.isEnabled = !active }
        }
    }
}
