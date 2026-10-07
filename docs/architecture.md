# Architecture

```
 home network                                 jhubuntu (docker compose)                  anywhere
┌────────────────────┐   websocket (out)   ┌───────────────────────────────────┐   https   ┌──────────┐
│ ESP32-CAM          │ ──────────────────▶ │ app (node 20)                     │ ◀──────── │ browser  │
│  camera task       │   jpeg + json       │  device-socket   frames ─▶ mjpeg  │           │ phone    │
│  frame hub         │                     │  devices         motion ─▶ events │  socket.io│          │
│  stream / local    │ ◀── http (ota) ──── │  browser-socket  storage          │ ◀───────▶ │          │
└────────────────────┘                     │  mongo: users, devices, events    │           └──────────┘
   http://<ip>/ (LAN, key)                 └───────────────────────────────────┘
```

## Firmware (`firmware/`, ESP-IDF v5.1.6, C)

Modules follow ESW0009: one encapsulated task per `KL_*.c` file (the prefix ESW0009 spells `IC_`), `DEBUG*` macros for the serial output, settings in nvs through `KL_nvs`.

One ESP-IDF project per product (`cam/`, `air/`) on the shared component `components/kibbl_core`: `KL_stream`, `KL_commands`, `KL_wifi_prov`, `KL_config` (server url, device secret, local key), `KL_ota`, `KL_nvs`, `KL_serial`, `KL_time`. The core calls the product through `KL_product.h` (info, its commands, telemetry, the stream work, what stops for an update, factory reset) and shows its status through `KL_status_led.h`; each product implements both in its `main` (linked as `WHOLE_ARCHIVE`, nothing in `main` calls the hooks itself).

### kibbl. cam (`cam/`)

| Module          | Task |
| --------------- | ---- |
| `main.c`        | boot order, network start, three-power-cycle Wi-Fi reset |
| `KL_product`    | the core's hooks: camera info and commands, frames to the server at its rate |
| `KL_camera`     | esp32-camera driver, jpeg, settings applied to the sensor |
| `KL_frame`      | one camera task at the highest rate any consumer asks for; the latest frame is copied out per consumer, so a slow upload never holds a driver buffer |
| `KL_stream`     | websocket to the server: hello, telemetry, commands, frames at the server's rate |
| `KL_local_http` | page and mjpeg stream on the home network (port 80/81, local key) |
| `KL_commands`   | the command set of serial and server (`docs/protocol.md`) |
| `KL_wifi_prov`  | SoftAP provisioning (`KIBBL-xxxxxx`, security 1), reconnect with back-off, scan, network change with fallback |
| `KL_camera_config` | camera settings in nvs |
| `KL_ota`        | https/http ota into the other slot; kept once it reached the server or ran 5 min, else rolled back |
| `KL_light`      | flash led pwm, capped at `CONFIG_KIBBL_LIGHT_MAX_PERCENT` |
| `KL_status_led` | red led: slow = provisioning, fast = connecting, three blinks = Wi-Fi connected, blip = online, double = no camera |

### kibbl. air (`air/`): the Conny CO2 traffic light

ISIS IC EHW0001-0013 with a new firmware (the original ESW0002 is backed up in `(40) Conny/backup`). ESP32-C3; the SCD30 and an io expander (PCA9554 or PCF8574A, found at boot) on one I2C bus (IO4/IO5, 100 kHz); the leds (red, green, amber, neutral white, on/off through constant current drivers) and the WDI of the external watchdog MAX6371 are expander pins. Everything below runs without the network; events wait for the server.

| Module          | Task |
| --------------- | ---- |
| `main.c`        | boot order: the watchdog feed first, then the measurement, then the network |
| `KL_product`    | the core's hooks: state, commands (`air_config`, `fan`, `lamp`, `blink`, `night`, `calibrate`), telemetry, events |
| `KL_air`        | the measurement task: SCD30 every 2 s, the mean of 3 for the traffic light with 50 ppm hysteresis, buzzer, fan auto, the detectors, forced recalibration, night mode; temperature corrected for the warmth of the board (ESW0002's measurements: 4-12 °C by leds and fan) |
| `KL_smoke`      | cigarettes from CO2 puffs of exhaled smoke (a short spike above a slow baseline, back within 90 s; 3 puffs within 4 min); the button logs one by hand, the event says whether a press belongs to it |
| `KL_fire`       | a possible fire (CO2 and heat rising together, heat rising fast, or 60 °C at the sensor): red flashing and the alarm pattern of smoke alarms, also at night; the button silences it, 5 calm minutes end it |
| `KL_window`     | an open window: 30 s means over 3 min, the CO2 falling towards 420 ppm with the temperature, or steeply alone; closed when either rises |
| `KL_events`     | the events queue (32), sent in order with their age once the server is reached |
| `KL_scd30`      | Sensirion SCD30 over I2C with crc, settings written only when they differ (they live in its flash) |
| `KL_ioexp`      | the expander, the power-on flag (it keeps its state over an ESP reset), the watchdog feed task (1 s) |
| `KL_lamp`       | the traffic light task: blinks, provisioning and errors in white, night off, modes traffic/off/white/warm/candle/custom colours; a change fades over 0.6 s by switching fast between the old and the new look |
| `KL_fan`        | pwm 25 kHz: off, on, pulse, auto (from yellow), capped at night |
| `KL_buzzer`     | the tones of ESW0002 on a timer, muted at night |
| `KL_button`     | short press: a cigarette logged; held 10 s: the Wi-Fi forgotten |
| `KL_air_config` | thresholds, buzzer, asc, altitude, lamp, fan, smoke, night fan in nvs |

Memory: frames live in PSRAM (4 MB on the ESP32-CAM); the driver keeps two UXGA-sized jpeg buffers, the hub and each consumer one copy that grows with the frame.

## Server (`backend/`, TypeScript, Express)

One process on purpose: the device sockets, the stream viewers and the motion state live in its memory.

* `sockets/device-socket.ts`: authenticates the upgrade (trust on first use), routes json and frames.
* `core/devices.ts`: who is connected, commands with responses, and the **stream demand**: live rate while viewers or snapshot requests exist, motion rate while motion detection is on, else 0. The camera sends nothing nobody needs.
* `core/frames.ts`: latest frame per camera, the mjpeg responses (`multipart/x-mixed-replace`, any `<img>` plays it), slow viewers skip frames instead of falling behind.
* `core/motion.ts` + `motionDetector.ts`: every analysed frame is shrunk to 64×48 grey and compared to a learned background. Changed share above the sensitivity threshold in two frames in a row starts an event; 10 s of calm ends it. Light switched on or a changed exposure (mean jump, more than 55 % changed) resets the background instead. Only when the camera's `motion.keepPictures` is on (off by default) is a picture kept: the frame with the most change. Otherwise the event is activity only (start, end, how much moved) and no frame is written; switched on during an event, that event takes the next frame. Pictures already kept stay when it is switched off, until deleted in the app (`deleteEventPictures`, the events stay) or by retention. A change of the whole picture's brightness (auto exposure, clouds) is subtracted before pixels are compared. A new motion event flashes the camera's white light once (`blink`); the 2 s after a flash are not analysed and the next frame becomes the background, so the flash and the settling exposure never count as motion.
* `core/storage.ts`: kept pictures on disk by camera and day, deleted with their events after `RETENTION_DAYS`.
* `health/`: the data of a fitness tracker (a Fitbit Air) through the **Google Health API v4**, ported from whoofit, and **kept on this server**. `google.ts` signs in with OAuth 2.0 + PKCE, refreshes tokens and waits when Google rate-limits (429). `tokens.ts` keeps the tokens encrypted (AES-256-GCM, key from `HEALTH_TOKEN_KEY` or `JWT_SECRET`) in `healthlinks`. `history.ts` fetches everything once, newest first: every data type in 30-day windows back until 90 days in a row bring nothing (heart rate zones do not count: Google computes them for any day), then the heart rate of every complete day at full resolution; resumable. After that only the latest data: each sync of the tracker re-reads the last 2 days (Google revises them, sleep is reprocessed), and a day's heart rate is stored once the tracker synced after it ended. `store.ts`: the data points as Google sent them in `healthpoints` by type and civil day, a fetched window replacing what was stored for its days (idempotent, never doubled); heart rate as binary per day in `heartratedays` (~300 kB a day). `extract.ts` turns points into series (whoofit's parsers, identical output, Python rounding included), `service.ts` builds the page's summary from the stored points for 30 days, 90 days, a year or all, cached until the next change. Data types that start to return data are found every 30 minutes, fetched back once and stored from then on.
* `meters/`: meters of the **EMONI LoRaWAN server** (ttn-chirpstack-webhook, container `emoni-lorawan` on the same host), **copied to this server**. `source.ts` reads its api (`METER_SOURCE_URL`) over its docker network. `service.ts` copies everything once (every reading with meter value, battery voltage and RSSI; consumption per day, month and year in Europe/Berlin, the months and years back to the manual readings before the meter reported), then, each time the source announces a reading on its live stream (server-sent events, `/events`), the readings after the newest stored one and the latest 3 days, 2 months and 2 years again (every reconnect catches up with all meters), and tells the open pages (`meterUpdate`); upserts on unique indexes, never doubled (`meters`, `meterreadings`, `meterperiods`). The state: latest reading, power over the last 2 hours (a meter counting in 0.1 kWh steps repeats its value), today, the battery in % between the source's full and empty voltage, its drain per day in the current cycle and the days left.
* `core/air.ts`: the kibbl. air. Its telemetry (every 10 s) is stored as a mean per minute (`airreadings`, unique by device and minute); its events (`smoke`, `window`, `fire`) are dated by their `ageSeconds` and kept in `airevents`; cigarettes per day count every press of the button plus the detected ones no press belongs to. Night mode by schedule: every telemetry says whether it is on, the server sends `night` when that is not what the schedule says, a switch in the app holds until the schedule changes next. A health hint of the climate (`shared/climate.ts`) that lasts 30 min goes to the owner, the same one at most every 12 h, never in night mode; a window opened and a fire at once.
* `shared/climate.ts`: the room climate and health: temperature (WHO 18 °C), humidity (40-60 %), CO2 (German Environment Agency), mould at the inner surface of outer walls (estimated with the outside temperature and fRsi 0.7 of DIN 4108-2; 80 % there lets mould grow), what airing does now (water in g/m³ inside and outside). Shared by the app and the alerts.
* `core/weather.ts`: temperature and humidity outside the home from Open-Meteo, kept 15 min per place: the home location each account chooses in Settings (searched with Open-Meteo's geocoding, or the browser's location; rounded to about 1 km), else `HOME_LATITUDE`/`HOME_LONGITUDE` of the server.
* `core/notify.ts`: alerts to a device's owner by e-mail and, with `NTFY_URL`, as ntfy push messages (a fire with the highest priority).
* `sockets/browser-socket.ts`: the app's api over socket.io, cookie-authenticated; device commands are whitelisted by capability and field-checked.

## App (`frontend/`, Vite, Tabler)

Multi-page like the enny-cloud-app-service: `src/pages/*.html` with the navbar partial injected at build time, one script per page, built into `backend/dist/frontend`.

| Page          | Content |
| ------------- | ------- |
| `/`           | cameras with their latest picture, next to them each meter with its last 14 days and the resting heart rate of 30 days, today's activity by hour, latest events, controls of non-camera devices |
| `/camera/:id` | live view (pauses when the tab is hidden), snapshot, full screen, status, light, motion settings with quiet hours and keeping pictures (count, delete), picture settings, 14-day heatmap |
| `/activity`   | 14-day heatmap (days × hours), day statistics, events per hour against the other days' median and 25–75 / 10–90 % bands, timeline |
| `/health`     | tracker with battery, last sync and latest heart rate, last night's stages, metric cards (resting heart rate, HRV, blood oxygen, breathing, skin temperature, active zone minutes, sedentary) with trend and 30 days, a day at full resolution behind the cards (heart rate per minute with zones, blood oxygen, zone minutes, worn/active/sedentary timeline), sleep per night by stage, sleep stage through the night as quantile bands, heart rate zones, breathing by sleep stage, workouts, newly found data types, connect and disconnect Google Health |
| `/air/:id`    | a kibbl. air: CO₂, temperature (with outside), humidity, cigarettes today, window; room climate and health hints; CO₂ and climate over 24 h, 7 or 30 days; cigarettes per day; what it noticed; light (presets, own colours, fade), night (now and schedule, fan), thresholds and buzzer, fan, detection, calibration |
| `/meter/:id`  | reading, power, today, battery; consumption by day, month or year with total, mean, peak and the bars; meter reading over 2, 7 or 30 days; updated as each reading arrives |
| `/devices`    | setup over USB (Web Serial: Wi-Fi scan, network, name, server address), Wi-Fi change with fallback, approve/reject, rename, restart, firmware update, remove; the trackers of Google Health with battery and last sync; the meters with reading and battery, add a meter by its uuid, remove one |
| `/settings`   | password, theme, privacy |

## Next steps

* Telling pets from people: run an object detector (e.g. YOLO or MobileNet-SSD via onnxruntime-node) on each event snapshot and label the event `cat`, `dog`, `person`.
* Push notifications for motion while away (quiet hours already exist; add "notify" hours).
* Clips: keep the frames of an event as a short mp4 instead of one snapshot.
* Schedules for the feeder and heating once those devices exist.
