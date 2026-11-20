# R8 rules for the release build (minifyEnabled). Capacitor finds plugins by class name from
# capacitor.plugins.json and calls their methods by name from JavaScript, so neither may be renamed or removed.

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# Capacitor core and every Capacitor plugin (also covers our own plugins in com.apexvelo.lab.plugins)
-keep class com.getcapacitor.** { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.PluginMethod public <methods>;
    public <init>(...);
}
-keep class com.apexvelo.lab.** { *; }

# Cordova plugins bridged by Capacitor
-keep class org.apache.cordova.** { *; }
-keep public class * extends org.apache.cordova.CordovaPlugin { *; }

# Methods the WebView calls through addJavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# @capacitor-community/sqlite: SQLCipher's native code finds its Java classes by name (JNI). Tink (through
# androidx.security-crypto) references annotations that exist only at compile time.
-keep class net.zetetic.database.** { *; }
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# Keep line numbers so Play Console crash reports can be deobfuscated with the uploaded mapping file
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
