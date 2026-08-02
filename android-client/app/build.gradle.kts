plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.homeworkapp.client"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.homeworkapp.client"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    // Фиксированный debug-keystore (файл debug.keystore рядом, в корне android-client/) -
    // без него каждый CI-запуск (GitHub Actions) генерировал бы СВОЙ случайный debug-сертификат,
    // и при попытке поставить новую сборку поверх старой (с другой подписью) Android тихо
    // отказывает с общей ошибкой "Приложение не установлено" - помогает только полное удаление
    // старой версии перед каждой новой установкой. С фиксированным ключом подпись всегда одна
    // и та же, обновления ставятся поверх старых версий как обычно.
    signingConfigs {
        getByName("debug") {
            storeFile = file("../debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Разрешаем собирать неподписанный/debug-подписанный релизный APK для sideload без настройки keystore.
    // Если понадобится публикация в Play Store - подключите свой signingConfig отдельно.
    buildFeatures {
        viewBinding = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
