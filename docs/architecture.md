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

| Module          | Task |
| --------------- | ---- |
| `main.c`        | boot order, network start, serial commands, three-power-cycle Wi-Fi reset |
| `KL_camera`     | esp32-camera driver, jpeg, settings applied to the sensor |
| `KL_frame`      | one camera task at the highest rate any consumer asks for; the latest frame is copied out per consumer, so a slow upload never holds a driver buffer |
| `KL_stream`     | websocket to the server: hello, telemetry, commands, frames at the server's rate |
| `KL_local_http` | page and mjpeg stream on the home network (port 80/81, local key) |
| `KL_commands`   | the command set of serial and server (`docs/protocol.md`) |
| `KL_wifi_prov`  | SoftAP provisioning (`KIBBL-xxxxxx`, security 1), reconnect with back-off, scan, network change with fallback |
| `KL_config`     | server url, device secret, local key, camera settings |
| `KL_ota`        | https/http ota into the other slot; kept once it reached the server or ran 5 min, else rolled back |
| `KL_light`      | flash led pwm, capped at `CONFIG_KIBBL_LIGHT_MAX_PERCENT` |
| `KL_status_led` | red led: slow = provisioning, fast = connecting, three blinks = Wi-Fi connected, blip = online, double = no camera |

Memory: frames live in PSRAM (4 MB on the ESP32-CAM); the driver keeps two UXGA-sized jpeg buffers, the hub and each consumer one copy that grows with the frame.

## Server (`backend/`, TypeScript, Express)

One process on purpose: the device sockets, the stream viewers and the motion state live in its memory.

* `sockets/device-socket.ts`: authenticates the upgrade (trust on first use), routes json and frames.
* `core/devices.ts`: who is connected, commands with responses, and the **stream demand**: live rate while viewers or snapshot requests exist, motion rate while motion detection is on, else 0. The camera sends nothing nobody needs.
* `core/frames.ts`: latest frame per camera, the mjpeg responses (`multipart/x-mixed-replace`, any `<img>` plays it), slow viewers skip frames instead of falling behind.
* `core/motion.ts` + `motionDetector.ts`: every analysed frame is shrunk to 64×48 grey and compared to a learned background. Changed share above the sensitivity threshold in two frames in a row starts an event; 10 s of calm ends it. Light switched on or a changed exposure (mean jump, more than 55 % changed) resets the background instead. Only when the camera's `motion.keepPictures` is on (off by default) is a picture kept: the frame with the most change. Otherwise the event is activity only (start, end, how much moved) and no frame is written; switched on during an event, that event takes the next frame. Pictures already kept stay when it is switched off, until deleted in the app (`deleteEventPictures`, the events stay) or by retention. A change of the whole picture's brightness (auto exposure, clouds) is subtracted before pixels are compared. A new motion event flashes the camera's white light once (`blink`); the 2 s after a flash are not analysed and the next frame becomes the background, so the flash and the settling exposure never count as motion.
* `core/storage.ts`: kept pictures on disk by camera and day, deleted with their events after `RETENTION_DAYS`.
* `health/`: the data of a fitness tracker (a Fitbit Air) through the **Google Health API v4**, ported from whoofit, and **kept on this server**. `google.ts` signs in with OAuth 2.0 + PKCE, refreshes tokens and waits when Google rate-limits (429). `tokens.ts` keeps the tokens encrypted (AES-256-GCM, key from `HEALTH_TOKEN_KEY` or `JWT_SECRET`) in `healthlinks`. `history.ts` fetches everything once, newest first: every data type in 30-day windows back until 90 days in a row bring nothing (heart rate zones do not count: Google computes them for any day), then the heart rate of every complete day at full resolution; resumable. After that only the latest data: each sync of the tracker re-reads the last 2 days (Google revises them, sleep is reprocessed), and a day's heart rate is stored once the tracker synced after it ended. `store.ts`: the data points as Google sent them in `healthpoints` by type and civil day, a fetched window replacing what was stored for its days (idempotent, never doubled); heart rate as binary per day in `heartratedays` (~300 kB a day). `extract.ts` turns points into series (whoofit's parsers, identical output, Python rounding included), `service.ts` builds the page's summary from the stored points for 30 days, 90 days, a year or all, cached until the next change. Data types that start to return data are found every 30 minutes, fetched back once and stored from then on.
* `sockets/browser-socket.ts`: the app's api over socket.io, cookie-authenticated; device commands are whitelisted by capability and field-checked.

## App (`frontend/`, Vite, Tabler)

Multi-page like the enny-cloud-app-service: `src/pages/*.html` with the navbar partial injected at build time, one script per page, built into `backend/dist/frontend`.

| Page          | Content |
| ------------- | ------- |
| `/`           | cameras with their latest picture, today's activity by hour, latest events, controls of non-camera devices |
| `/camera/:id` | live view (pauses when the tab is hidden), snapshot, full screen, status, light, motion settings with quiet hours and keeping pictures (count, delete), picture settings, 14-day heatmap |
| `/activity`   | 14-day heatmap (days × hours), day statistics, events per hour against the other days' median and 25–75 / 10–90 % bands, timeline |
| `/health`     | tracker with battery, last sync and latest heart rate, last night's stages, metric cards (resting heart rate, HRV, blood oxygen, breathing, skin temperature, active zone minutes, sedentary) with trend and 30 days, a day at full resolution behind the cards (heart rate per minute with zones, blood oxygen, zone minutes, worn/active/sedentary timeline), sleep per night by stage, sleep stage through the night as quantile bands, heart rate zones, breathing by sleep stage, workouts, newly found data types, connect and disconnect Google Health |
| `/devices`    | setup over USB (Web Serial: Wi-Fi scan, network, name, server address), Wi-Fi change with fallback, approve/reject, rename, restart, firmware update, remove; the trackers of Google Health with battery and last sync |
| `/settings`   | password, theme, privacy |

## Next steps

* Telling pets from people: run an object detector (e.g. YOLO or MobileNet-SSD via onnxruntime-node) on each event snapshot and label the event `cat`, `dog`, `person`.
* Push notifications for motion while away (quiet hours already exist; add "notify" hours).
* Clips: keep the frames of an event as a short mp4 instead of one snapshot.
* Schedules for the feeder and heating once those devices exist.
