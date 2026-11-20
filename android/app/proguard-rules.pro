# R8 keeps for the release builds.
#
# The app and :core are full of kotlinx.serialization models: 120 @Serializable
# classes. Their generated serializers are reached through a companion method
# (`Foo.Companion.serializer()`) that R8 cannot see called, and enum wire values
# are the enum constant names, which R8 would otherwise rename. These are the
# library's documented rules, scoped to this app's packages.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class com.lunabot.companion.**$$serializer { *; }
-keepclassmembers class com.lunabot.companion.** {
    *** Companion;
}
-keepclasseswithmembers class com.lunabot.companion.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# Enum constants are wire values (`role`, `kind`, `crop`): renaming them would
# silently turn a known value into UNKNOWN.
-keepclassmembers enum com.lunabot.companion.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
    **[] $VALUES;
    public *;
}

# The device token is wrapped by Tink through androidx.security.crypto, which
# loads providers reflectively. Tink also carries an optional remote keyset
# downloader that references Google API Client and Joda, neither of which this
# app ships or reaches.
-keep class com.google.crypto.tink.** { *; }
-keep class com.google.protobuf.** { *; }
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**

# ML Kit's bundled QR model enters through JNI and reflection; the native
# library resolves the Java classes by name.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }

# sherpa-onnx is reached from native code the same way: the JNI side reads the
# Kotlin config and result data classes by field name.
-keep class com.k2fsa.sherpa.onnx.** { *; }

# Keep the line numbers and source file names in crash reports; the app is
# sideloaded and a stack trace is the only diagnostic a user can send.
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile

# The phone-UI shell helper is launched from a shell command that names its
# entry-point class on the app_process command line, so R8 must not rename it.
-keep class com.lunabot.companion.phoneui.shell.PhoneUiHelperMain {
    public static void main(java.lang.String[]);
}
