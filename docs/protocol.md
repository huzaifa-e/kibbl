# Device protocol

Every device of kibbl. (the ESP32-CAM today; a pet feeder, switches and heating later) talks to the server over **one websocket that the device opens itself**. The device works behind the home router without a port forward, and the server needs no access to the home network.

```
device ──── wss://<server>/device/socket ────▶ server ◀──── socket.io ──── app
         text: json (hello, telemetry, responses, commands)
         binary: jpeg frames (cameras only)
```

## Connecting

The upgrade request carries the identity in headers (never in the url, which ends up in proxy logs):

| Header          | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| `X-Device-Id`   | the Wi-Fi station MAC, 12 upper case hex characters (`C82E1824CFA8`)   |
| `Authorization` | `Bearer <secret>`: 32 lower case hex characters, random, made once per device and kept in its nvs |
| `User-Agent`    | `KibblHW`                                                        |

**Setup over USB** (Devices → *Set up over USB*, Chrome or Edge on https or localhost): the app opens the device's serial port with Web Serial, scans for networks, and writes the Wi-Fi and the server address (`DEVICE_SOCKET_URL`, else derived from `DEVICE_BASE_URL`) with the serial commands below. Before that it tells the server to expect the id: its next connection is approved with the name given in the app, and a device that was reset (new secret) is paired again instead of refused. The Wi-Fi password goes from the browser over the cable only.

**Setup with a phone** (no cable): a device without a network opens the open Wi-Fi `kibbl-xxxx` with a setup page (captive portal at `192.168.4.1`): the network, its password and the server address go to the device there; once it joined the network the page shows its **pairing code** (8 letters and digits, kept in nvs, new after a factory reset). The device sends the code's sha256 as `claimHash` in its hello; in the app, *Devices → Add with a code* takes a pending device without owner whose hash matches into the account of who typed it, approved and named (10 tries per account in 10 minutes).

**Otherwise pairing is trust on first use.** An unknown id is stored with the hash of its secret as a *pending* device and appears in the app under Devices, where it is approved or rejected. A pending device stays connected but nothing it sends reaches anybody. From then on the server refuses the id with any other secret (HTTP 401): a factory reset makes a new secret, so the device must be removed in the app and approved again. At most 5 devices can wait for approval at once (HTTP 429 beyond).

The device pings every 10 s; the server closes a connection that was silent for 35 s. A device reconnects 5 s after any disconnect.

## Device → server

### `hello` (first message after every connect)

```json
{
    "type": "hello",
    "fw": "KIBBL-1a2b3c4d",
    "deviceId": "C82E1824CFA8",
    "model": "kibbl-cam",
    "board": "ai-thinker-esp32-cam",
    "sensor": "OV2640",
    "hostname": "kibbl-cfa8",
    "ip": "192.168.0.57",
    "ssid": "home",
    "provisioned": true,
    "wifiChangeFailed": "home-5g",
    "rssi": -61,
    "uptime": 12,
    "heap": 157083,
    "psram": 3423068,
    "resetReason": 1,
    "caps": ["camera", "light", "ota"],
    "camera": { "framesize": "VGA", "quality": 12, "vflip": false, "hmirror": false, "brightness": 0, "contrast": 0, "saturation": 0 },
    "light": 0
}
```

`model` is the product (`kibbl-cam`, `kibbl-feeder`, …): the app names a device by it (`productNames` in `shared/protocol.ts`) and never shows `board` or `sensor`, which are there for diagnosis. `caps` decides which controls the app shows and which commands the server lets through (`shared/protocol.ts`). `wifiChangeFailed` is only present after a `wifi` change from the app that did not work: the device went back to `ssid`.

### `telemetry` (every 10 s)

```json
{ "type": "telemetry", "uptime": 3600, "rssi": -61, "heap": 150000, "psram": 3300000, "cameraFps": 2, "fps": 2, "frameBytes": 24500 }
```

A kibbl. air adds its state to the hello and to every telemetry: `co2` (ppm, mean of 3 readings), `temperature` (°C, corrected for the warmth of the board), `humidity`, `level` (`none`, `green`, `yellow`, `red`), `fan` (pwm % now), `window` (`open`, `closed`, `paused` while the detectors rest during a calibration and 15 min after), `night`, `calibrating`, `puffs` (of a cigarette going on), `fire` (its alarm sounds), `sensorError` (while the CO2 sensor does not answer); its hello also `air`, `fanSettings` and `lamp` (the settings below), `sensor`, `expander`, `powerOn`.

### `event` (kibbl. air)

```json
{ "type": "event", "event": "smoke", "source": "auto", "puffs": 5, "durationSeconds": 240, "peakPpm": 1310, "button": false, "delaySeconds": 240, "ageSeconds": 0 }
{ "type": "event", "event": "smoke", "source": "button", "ageSeconds": 0 }
{ "type": "event", "event": "window", "state": "open", "co2": 640, "co2Before": 1020, "temperatureChange": -0.9, "ageSeconds": 0 }
{ "type": "event", "event": "window", "state": "closed", "co2": 610, "co2Before": 580, "temperatureChange": 0.4, "openSeconds": 720, "ageSeconds": 0 }
{ "type": "event", "event": "fire", "co2": 1450, "co2Rise": 520, "temperature": 34.1, "temperatureRise": 2.3, "ageSeconds": 0 }
```

A `fire` event comes with the alarm of the device (red flashing, the buzzer, also in night mode, a press of the button silences it): CO₂ and temperature rising together within a minute, the temperature rising 2 °C a minute for two minutes, or the sensor at 60 °C.

The device has no clock: an event happened `ageSeconds` (it waited for the server) plus `delaySeconds` (a cigarette is known only 4 min after its last puff) before it arrived. A cigarette found by the detector with `button: true` was logged with the button already and counts once.

### `response` (to every command)

```json
{ "type": "response", "id": 7, "ok": true, "camera": { "framesize": "SVGA", "...": "..." } }
{ "type": "response", "id": 8, "ok": false, "error": "level must be 0 to 100" }
```

### Frames (cameras)

Binary messages, each one complete jpeg (`FF D8 …`), at most 1 MB. The device sends frames only at the rate the server asked for with `stream`.

## Server → device: commands

Every command has a numeric `id` that the response repeats; the device's own id is `deviceId`, so the two never collide.

| Command       | Capability | Fields                                                                       | Response data |
| ------------- | ---------- | ---------------------------------------------------------------------------- | ------------- |
| `info`        | all        | –                                                                            | the hello fields |
| `reboot`      | all        | –                                                                            | – (restarts 1 s later) |
| `wifi_scan`   | all        | –                                                                            | `networks`: `[{ssid, rssi, secure}]`, strongest first, one per ssid |
| `wifi`        | all        | `ssid` 1–32, `password` 8–63 or empty                                        | `pending`, `fallbackSeconds`: switches in the background, back to the old network without an ip in 30 s |
| `stream`      | camera     | `fps` 0–255 (capped by the device, 15 on the ESP32-CAM); 0 stops             | – |
| `camera`      | camera     | any of `framesize` (`QVGA` … `UXGA`), `quality` 4–63, `vflip`, `hmirror`, `brightness`/`contrast`/`saturation` −2…2 | `camera`: all settings |
| `light`       | light      | `level` 0–100                                                                | `light` |
| `blink`       | blink      | `count` 1–10 (2), `level` 1–100 (30): flashes the white light, then back to its level (air: `count` only) | – |
| `ota`         | ota        | `url`: http(s) url of an application image                                   | – (downloads, restarts) |
| `switch`      | switch     | `channel` (string), `on` (bool)                                              | – |
| `feed`        | feeder     | `portions` 1–10                                                              | – |
| `thermostat`  | thermostat | `target` 5–30 (°C)                                                           | – |
| `air_config`  | air        | any of `yellow` 400–5000, `red` 400–10000 (> yellow), `buzzer`, `asc`, `altitude` 0–3000, `smoke`, `puffRise` 30–2000, `nightFan` 0–100 | `air`, `fanSettings`, `lamp` |
| `fan`         | fan        | any of `mode` (`off`, `on`, `pulse`, `auto`), `level` 1–100, `onSeconds`/`offSeconds` 1–3600 | as `air_config` |
| `lamp`        | lamp       | any of `mode` (`traffic`, `off`, `white`, `warm`, `candle`, `custom`), `colors` (of `red`, `green`, `yellow`, `white`, for custom), `fade` | as `air_config` |
| `night`       | night      | `on` (bool): lamp off, buzzer muted, fan at most `nightFan`; not stored, the server sends it on its schedule | `night` |
| `calibrate`   | calibrate  | `ppm` 400–2000 (420): 5 min in fresh air, then the sensor takes the value; smoke, window and the fire rates pause until 15 min after | `pending`, `seconds` |

The server asks a camera for frames only when needed: the live rate (`STREAM_FPS`, 30) while someone watches or a snapshot is due, the motion rate (`MOTION_FPS`, 2) while motion detection is on, otherwise 0.

## Serial commands (USB, 115200 baud)

The same json, one per line, plus the ones only someone holding the device may send:

| Command                                                  | Effect |
| -------------------------------------------------------- | ------ |
| `{"cmd":"info"}`                                         | everything above, plus the server url and the local stream url with its key |
| `{"cmd":"wifi","ssid":"…","password":"…"}`               | joins that network at once, no fallback (also ends provisioning) |
| `{"cmd":"wifi_reset"}`                                   | forgets the network, restarts into provisioning |
| `{"cmd":"server","url":"wss://…/device/socket"}`          | stores the server url, restarts |
| `{"cmd":"debug"}`                                        | debug output on/off (kept in nvs) |
| `{"cmd":"factory_reset"}`                                | new device secret, no network, default server |

## Adding a device type

1. Implement the connection, `hello` with your `caps`, `telemetry` and `response` as above; `backend/scripts/simulate-device.ts` is a working reference in 150 lines.
2. Add the capability and its commands to `shared/protocol.ts` and the field check to `cleanCommand()` in `backend/src/sockets/browser-socket.ts`.
3. Add its controls to `frontend/src/script/controls.ts`.
