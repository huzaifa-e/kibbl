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
* `core/motion.ts` + `motionDetector.ts`: every analysed frame is shrunk to 64×48 grey and compared to a learned background. Changed share above the sensitivity threshold in two frames in a row starts an event; 10 s of calm ends it. Light switched on or a changed exposure (mean jump, more than 55 % changed) resets the background instead. The frame with the most change is the event's snapshot.
* `core/storage.ts`: snapshots on disk by camera and day, deleted with their events after `RETENTION_DAYS`.
* `sockets/browser-socket.ts`: the app's api over socket.io, cookie-authenticated; device commands are whitelisted by capability and field-checked.

## App (`frontend/`, Vite, Tabler)

Multi-page like the enny-cloud-app-service: `src/pages/*.html` with the navbar partial injected at build time, one script per page, built into `backend/dist/frontend`.

| Page          | Content |
| ------------- | ------- |
| `/`           | cameras with their latest picture, today's activity by hour, latest events, controls of non-camera devices |
| `/camera/:id` | live view (pauses when the tab is hidden), snapshot, full screen, status, light, motion settings with quiet hours, picture settings, 14-day heatmap |
| `/activity`   | 14-day heatmap (days × hours), day statistics, snapshot timeline |
| `/devices`    | setup over USB (Web Serial: Wi-Fi scan, network, name, server address), Wi-Fi change with fallback, approve/reject, rename, restart, firmware update, remove |
| `/settings`   | password, theme, privacy |

## Next steps

* Telling pets from people: run an object detector (e.g. YOLO or MobileNet-SSD via onnxruntime-node) on each event snapshot and label the event `cat`, `dog`, `person`.
* Push notifications for motion while away (quiet hours already exist; add "notify" hours).
* Clips: keep the frames of an event as a short mp4 instead of one snapshot.
* Schedules for the feeder and heating once those devices exist.
