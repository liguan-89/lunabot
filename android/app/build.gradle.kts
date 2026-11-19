import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("plugin.compose")
    kotlin("plugin.serialization")
    id("androidx.baselineprofile")
}

// The release signing key belongs to the maintainer and never enters this
// repository. It reaches a build from one of two places outside version
// control:
//
//   * `android/keystore.properties` — gitignored, for signing by hand. Four
//     keys: `storeFile` (a path, absolute or relative to `android/`),
//     `storePassword`, `keyAlias`, and optionally `keyPassword`.
//   * the environment — for CI, where the material arrives as secrets:
//     OPENMAUSBOT_KEYSTORE_FILE, OPENMAUSBOT_KEYSTORE_PASSWORD,
//     OPENMAUSBOT_KEY_ALIAS, and optionally OPENMAUSBOT_KEY_PASSWORD.
//
// The environment wins over the file, so a runner cannot silently inherit a
// stale `keystore.properties` left behind in a cached workspace.
//
// When none of it is present the release build is unsigned, and that is a
// supported outcome rather than a degraded one: `assembleRelease` writes
// `app-release-unsigned.apk` for the maintainer to sign with his own key on his
// own machine. A signed build writes `app-release.apk` instead, so the filename
// alone says which of the two happened.
private val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use(::load)
}

private fun signingMaterial(property: String, environment: String): String? =
    (System.getenv(environment) ?: keystoreProperties.getProperty(property))
        ?.takeIf(String::isNotBlank)

private val storeFilePath = signingMaterial("storeFile", "OPENMAUSBOT_KEYSTORE_FILE")
private val storePasswordValue = signingMaterial("storePassword", "OPENMAUSBOT_KEYSTORE_PASSWORD")
private val keyAliasValue = signingMaterial("keyAlias", "OPENMAUSBOT_KEY_ALIAS")
// A PKCS12 keystore — keytool's default since JDK 9, and what `-storetype PKCS12`
// produces — holds one password for the store and the key alike, so the key
// password may be left out rather than repeated.
private val keyPasswordValue =
    signingMaterial("keyPassword", "OPENMAUSBOT_KEY_PASSWORD") ?: storePasswordValue

// All three required values, or none of them. A build handed some of them is a
// build somebody meant to sign, and answering that with an unsigned APK would
// hand back something that looks finished and cannot be published. It stops here
// instead, naming what is missing.
private val releaseSigningMaterial = mapOf(
    "storeFile / OPENMAUSBOT_KEYSTORE_FILE" to storeFilePath,
    "storePassword / OPENMAUSBOT_KEYSTORE_PASSWORD" to storePasswordValue,
    "keyAlias / OPENMAUSBOT_KEY_ALIAS" to keyAliasValue,
)
private val releaseKeystore: java.io.File? = when {
    releaseSigningMaterial.values.all { it == null } -> null
    releaseSigningMaterial.values.any { it == null } -> error(
        releaseSigningMaterial.filterValues { it == null }.keys.joinToString(
            prefix = "Release signing is half-configured. Missing: ",
            separator = ", ",
            postfix = ". Supply all of it, or none of it for an unsigned build.",
        )
    )
    else -> rootProject.file(storeFilePath!!).also {
        if (!it.isFile) error("Release keystore not found at ${it.absolutePath}.")
    }
}

// The one line to edit at a release. `versionCode` is derived from it below, so
// there is no second number to bump and no way to build a new version under a
// code the Play Store has already accepted.
private val appVersionName = "2.1.1"

// Play orders uploads by `versionCode` alone and refuses one it has already
// seen, so the code has to rise whenever the name does — and rise in the
// direction a human reads the name. MAJOR * 10000 + MINOR * 100 + PATCH does
// that for any `X.Y.Z` with each part in 0..99: 1.0.0 is 10000, 1.0.1 is 10001,
// 1.2.0 is 10200, 2.0.0 is 20000. A name outside that shape fails the build
// rather than resolving to some number nobody chose.
//
// Nothing has shipped under `versionCode = 1`, so opening at 10000 costs
// nothing; it could not be undone later, because an installer refuses to
// replace an app with a lower code and Play refuses the upload outright.
private val appVersionCode = run {
    val parts = appVersionName.split(".").map { it.toIntOrNull() ?: -1 }
    check(parts.size == 3 && parts.all { it in 0..99 }) {
        "versionName must be MAJOR.MINOR.PATCH with each part in 0..99 for a " +
            "versionCode to be derived from it; got \"$appVersionName\"."
    }
    parts[0] * 10_000 + parts[1] * 100 + parts[2]
}

android {
    namespace = "com.lunabot.companion"
    compileSdk = 37

    defaultConfig {
        // Luna Bot's own install identity. The namespace stays the source
        // package until the Kotlin package migration lands.
        applicationId = "com.lunabot.companion"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
        ndk {
            // Development targets real phones only. x86/x86_64/armeabi-v7a
            // natives only bloat every APK and every build; arm64 is enough.
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        // Created only when the material above resolved. Absent otherwise, which
        // is what leaves `release` unsigned.
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
                // v2 covers every device this app runs on (minSdk 26), and v3
                // is what makes the key rotatable later — without a v3 block in
                // the APK there is no signing lineage for a new key to prove it
                // descends from the old one. AGP leaves v3 off by default;
                // `apksigner sign` turns it on by default, so setting it here is
                // what keeps a Gradle-signed release byte-for-byte comparable to
                // one the maintainer signs by hand. v1 stays off: it is JAR
                // signing, for Android 6 and below, which minSdk already excludes.
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        create("preview") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".preview"
            versionNameSuffix = "-threads-preview"
            matchingFallbacks += "debug"
            // Reuse Gradle's local debug key; this package installs alongside
            // the separately signed release and keeps its own pairing/data.
            signingConfig = signingConfigs.getByName("debug")
        }
        /*
         * The personal update-channel build: arm64 (defaultConfig filters every
         * build to arm64-v8a), signed with the same debug key as the installed
         * app so it upgrades in place.
         *
         * One ABI and shrinking keep the download small. R8 stays off for the
         * reason release documents above — this build is the same tested code,
         * just for one ABI.
         */
        create("dist") {
            initWith(getByName("debug"))
            isDebuggable = false
            signingConfig = signingConfigs.getByName("debug")
            // The shipped update build wears the same R8 keeps as release: one
            // ABI and shrinking keep the download small. The keeps live in
            // proguard-rules.pro; a minified build is exercised by a real
            // pairing and session before it goes to the channel.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        release {
            // Null whenever no signing material was supplied — the unsigned
            // handover build — and the "release" config whenever it was.
            signingConfig = signingConfigs.findByName("release")

            // R8 is on. The serialization, Tink and ML Kit entry points R8
            // cannot see are kept in app/proguard-rules.pro; without those
            // rules a minified build installs and opens and then fails the
            // first frame off the socket. Resource shrinking is R8's and needs
            // the line above to be true.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        // AGP disables AIDL by default since 8.0; the phone-UI shell helper's
        // interface is the one .aidl source in the app.
        aidl = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged manifest and the compiled resources
            // to stand a real Android runtime up inside the JVM suite. Only the
            // handful of tests that mount a composition ask for it; the rest of
            // the suite never loads Robolectric at all.
            isIncludeAndroidResources = true
        }
    }
}

// The committed profile is the one the generator produced; the plugin is what
// compiles it into the APK's dexopt assets.
baselineProfile {
    // Keep the generated file in app/src/main so the profile is reviewable in
    // the repository rather than living only in a build directory.
    saveInSrc = true
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    // Part of Compose, version-managed by the BOM above: the ~40 icons in the
    // core set cover all but one glyph these screens draw, and that one — the
    // display in the chat header — is a vector in `res/drawable`. The
    // `-extended` artifact is deliberately not used: it is thousands of vectors
    // for a handful of uses.
    implementation("androidx.compose.material:material-icons-core")
    // Already on the classpath through material3; declared because the chat's +
    // sheet and the composer's + use `AnimatedVisibility` and `animateFloatAsState`
    // directly, and a direct use deserves a direct dependency.
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.13.0")
    // Backdrop blur for the floating chrome: records the transcript into a
    // GraphicsLayer once per frame and samples it blurred under each capsule —
    // the API-31+ path; older devices fall back to the style's solid tint.
    implementation("dev.chrisbanes.haze:haze:1.6.6")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.lifecycle:lifecycle-process:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.datastore:datastore-preferences:1.3.0")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("androidx.core:core-ktx:1.19.1")
    // The granted-folder view for bot file reads: a tree grant walked as documents.
    implementation("androidx.documentfile:documentfile:1.1.0")
    // Installs app/src/main/baseline-prof.txt on Android 11 and below; Android
    // 12+ reads the profile out of the APK directly. The file itself is
    // generated by :baselineprofile and committed.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    // Share inbound: apply EXIF orientation while downsampling shared photos.
    implementation("androidx.exifinterface:exifinterface:1.4.2")

    // 端侧流式语音识别（sherpa-onnx 1.13.5）。模型不在 APK 里，首次使用时
    // 按需下载到 filesDir，见 speech/ModelManager。
    implementation("com.github.k2-fsa.sherpa-onnx:sherpa-onnx:1.13.5")

    // On-device text recognition for screens the accessibility tree cannot
    // describe. The bundled Chinese/Latin model ships in the APK, so it works
    // without Google Play Services; only recognized text leaves the phone.
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")

    // Chrome Custom Tabs, for the cloud desktop's noVNC viewer — the Android
    // counterpart of the SFSafariViewController iOS uses. A hardened browser
    // process with its own visible origin, cookie jar and WebSocket support,
    // rather than a WebView that would put the provider's session inside this
    // process and hide the origin from someone about to grant full control of a
    // cloud machine. ~200 KB, no transitive weight beyond androidx.core.
    implementation("androidx.browser:browser:1.10.0")

    // Pairing QR scanner. CameraX gives the preview and frame pipeline; ML Kit's
    // *bundled* barcode model reads them. Bundled rather than the Play-services
    // variants (`play-services-code-scanner` / unbundled ML Kit) because pairing
    // happens on a LAN, often on a phone whose Google Play services cannot be
    // assumed — a scanner that needs a module download at the moment a two-minute
    // pairing window is open is a scanner that fails when it matters. It also
    // keeps the confirm-before-pair step in this process, where the app can show
    // the computer's name and address before anything is redeemed (§6).
    // Cost, measured on this APK: libbarhopper_v3.so is 4.95 MB per ABI plus
    // 0.88 MB of model assets — call it 6 MB on a device, since an app bundle
    // ships one ABI. That is the price of scanning without Play services; the
    // lever if it ever matters is `play-services-mlkit-barcode-scanning`, which
    // is a few hundred KB and downloads the model on demand. Scanning is
    // restricted to FORMAT_QR_CODE.
    implementation("androidx.camera:camera-core:1.6.2")
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-view:1.6.2")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.2.21")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("junit:junit:4.13.2")
    // The approval card's two buttons are only correct in what they put on the
    // wire — one standing grant, one answer, never two grants — so the test that
    // pins them drives a real Session against a real socket rather than a stub
    // that could agree with the wrong thing. Same server the :core tests use.
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.1")
    // The table card is only correct in the *order* a screen reader walks it,
    // and that order lives in the semantics tree — not in any value a pure
    // function could return. Robolectric stands the Android runtime up in the
    // JVM suite so `createComposeRule` can mount the card and the test can read
    // the tree it actually produces; without it the assertion would be about a
    // list the composable is free to ignore.
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation(composeBom)
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
