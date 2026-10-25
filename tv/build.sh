#!/usr/bin/env bash
# The TV app, built without Gradle (javac, d8, aapt2, zipalign, apksigner of the Android SDK):
#   tv/build.sh                         -> tv/build/kibbl-light.apk
#   tv/build.sh install <adb serial>    built, installed on the TV; with KIBBL_TV_TOKEN set (a token of
#                                       scope light: mcp-token.js create <e-mail> "<TV>" --light) it is given to the app
# Needs JDK 17 and the SDK's platform 34 and build-tools 34.0.0 (docs/tv.md).
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
BT=$SDK/build-tools/34.0.0
JAR=$SDK/platforms/android-34/android.jar
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
export PATH="$JAVA_HOME/bin:$PATH"
# the key the app is signed with: the same one for every update, kept outside the repository
KEYSTORE=${KIBBL_TV_KEYSTORE:-$HOME/.android/kibbl-tv.jks}

rm -rf build
mkdir -p build/classes build/gen
# the banner and the icon, from the logo of the app; made once, then kept in the repository
[ -f res/drawable-xhdpi/banner.png ] || swift tools/banner.swift ../frontend/public/img/logo.svg res/drawable-xhdpi/banner.png res/mipmap-xhdpi/ic_launcher.png
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java build/gen build/res.zip
javac -nowarn -source 11 -target 11 -classpath "$JAR" -d build/classes $(find src build/gen -name '*.java')
"$BT/d8" --min-api 26 --lib "$JAR" --output build $(find build/classes -name '*.class')
(cd build && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
if [ ! -f "$KEYSTORE" ]; then
    keytool -genkeypair -keystore "$KEYSTORE" -alias kibbl -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass kibbl-tv -keypass kibbl-tv -dname "CN=kibbl. light" 2>/dev/null
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:kibbl-tv --out build/kibbl-light.apk build/aligned.apk
echo "built tv/build/kibbl-light.apk ($(du -k build/kibbl-light.apk | cut -f1) KB)"

if [ "${1:-}" = install ]; then
    SERIAL=${2:?usage: build.sh install <adb serial, e.g. 192.168.0.176:41234>}
    adb -s "$SERIAL" install -r build/kibbl-light.apk
    if [ -n "${KIBBL_TV_TOKEN:-}" ]; then
        adb -s "$SERIAL" shell am start -n uk.kibbl.light/.MainActivity --es token "$KIBBL_TV_TOKEN" >/dev/null
        echo "the token was given to the app"
    fi
fi
