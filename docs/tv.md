# kibbl. light on the TV

`tv/` is a small Android TV app (plain Java, no libraries, ~40 KB) that controls the kibbl. light from the TV with the remote: on and off, dimmer and brighter, the moods and the effects of the light (docs/light.md), and a running effect stopped. It sits in Google TV's row of apps as *kibbl. light*; the home screen of the TV stays as it is.

## Server side

`/api/tv/light` (backend/src/routes/tv.ts): `GET` the user's lights with the moods and effects, `POST /api/tv/light/<id>` with one of `on`, `brightness`, `mood`, `effect` (`minutes` for sunrise and sunset) or `stop`. It takes only a token of scope `light`, which opens these two routes and nothing else (not the MCP endpoint):

    docker exec kibbl-app node mcp-token.js create <e-mail> "Bedroom TV" --light

The token shows in *Settings → Assistant* with a *light only* badge, where it is revoked like any other.

## Build and install

Needs JDK 17 and the Android SDK's platform 34 and build-tools 34.0.0 (no Gradle, no Android Studio):

    brew install openjdk@17 android-platform-tools && brew install --cask android-commandlinetools
    sdkmanager --sdk_root=/opt/homebrew/share/android-commandlinetools "platforms;android-34" "build-tools;34.0.0"

`tv/build.sh` builds `tv/build/kibbl-light.apk`, signed with `~/.android/kibbl-tv.jks` (made on the first build, kept outside the repository: an update must be signed with the same key). The banner and the icon are made from the logo by `tv/tools/banner.swift` once and kept in `tv/res`.

On the TV: Developer options, *Wireless debugging*, *Pair device with pairing code*; on the Mac `adb pair <ip:port> <code>`, then `adb mdns services` shows the address to connect to. Then:

    adb connect <ip:port>
    KIBBL_TV_TOKEN=kibbl_... tv/build.sh install <ip:port>

The token is given to the app once (an intent extra); an update needs no token. Switch Wireless debugging off afterwards.

The Bedroom TV is a Chromecast with Google TV 4K (debloated with cleanyourtv's list that keeps casting).
