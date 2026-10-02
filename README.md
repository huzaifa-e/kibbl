<p align="center">
    <h1 align="center">HOME-MONITOR</h1>
</p>
<p align="center">
    <em>Live camera, pet and people activity, and the home devices to come.</em>
</p>
<p align="center">
	<img src="https://img.shields.io/badge/C-A8B9CC.svg?style=default&logo=C&logoColor=black" alt="C">
	<img src="https://img.shields.io/badge/ESP--IDF-v5.1.6-E7352C.svg?style=default&logo=espressif&logoColor=white" alt="ESP-IDF">
	<img src="https://img.shields.io/badge/TypeScript-3178C6.svg?style=default&logo=TypeScript&logoColor=white" alt="TypeScript">
	<img src="https://img.shields.io/badge/Docker-2496ED.svg?style=default&logo=Docker&logoColor=white" alt="Docker">
</p>

Table of Contents

- [Overview](#overview)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
  - [Firmware](#firmware)
  - [Connecting the camera](#connecting-the-camera)
  - [Server and app](#server-and-app)
- [Debugging](#debugging)
- [Documentation](#documentation)

## Overview

| Supported Targets | ESP32 (AI-Thinker ESP32-CAM), ESP32-S3 (Freenove ESP32-S3 CAM) |
| ----------------- | -------------------------------------------------------------- |

An ESP32 camera at home streams live video to a server, which shows it in a web app and records when pets or people move in front of it. Further devices (pet feeder, heating, switches) join the same server over the same protocol.

* **Firmware**: ESP-IDF in C, conventions of ESW0009. Wi-Fi provisioning over SoftAP, one outbound websocket to the server (works behind the home router), jpeg frames at the rate the server asks for, local stream on the home network, firmware updates over the air with rollback.
* **Server**: Node/TypeScript as in the enny-cloud-app-service. Pairs devices (trust on first use, approved in the app), relays the stream as mjpeg, detects motion and keeps snapshots of it, deletes them after 14 days.
* **App**: live view with snapshot and full screen, camera and light controls, motion sensitivity and quiet hours, activity heatmap and timeline, device management with firmware upload.

## Repository Structure

```sh
└── home-monitor/
    ├── firmware/                 ESP-IDF project (C)
    │   ├── main/
    │   │   ├── main.c            entry point app_main()
    │   │   ├── IC_*.c / IC_*.h   modules, one task each (see docs/architecture.md)
    │   │   ├── Kconfig.projbuild board, server url, provisioning pop
    │   │   └── web/index.html    local stream page
    │   ├── hm_partition_tbl.csv  two OTA slots on 4 MB flash
    │   ├── sdkconfig.defaults
    │   ├── create_build_info.sh  FW_VERSION for CI builds
    │   └── env.sh                ESP-IDF v5.1.6 environment
    ├── backend/                  server (TypeScript, Express, socket.io, ws, MongoDB)
    │   ├── src/core/             devices, frames, motion, auth, storage
    │   ├── src/sockets/          device websocket, browser socket.io
    │   ├── src/routes/           login, stream, snapshots, firmware
    │   └── scripts/              simulate-device.ts
    ├── frontend/                 web app (Vite, Tabler)
    │   └── src/pages, src/script
    ├── shared/                   protocol types used by both
    ├── hardware/                 printed parts, parametric (build123d) with STEP and STL
    │   └── feeder/iris/          NEMA 17 iris valve that portions the cat food
    ├── docs/                     architecture, protocol, deployment
    ├── deploy/deploy.sh          deployment to jhubuntu
    ├── Dockerfile, docker-compose.yml
    └── .github/workflows/        firmware and app builds
```

Module files start with IC_ (for ISIS-IC) to distinguish them from ESP-IDF and component sources.

## Getting Started

### Firmware

```sh
cd firmware
source env.sh                                    # ESP-IDF v5.1.6
idf.py set-target esp32                          # esp32s3 for the Freenove board
idf.py menuconfig                                # Home Monitor: board, server url, pop
idf.py -p /dev/cu.usbserial-XXXX -b 460800 flash monitor
```

In a folder whose path contains parentheses, add `-B <build dir outside of it>` to every `idf.py` call (ESP-IDF 5.1 quotes that path wrongly).

### Connecting the camera

1. After the first flash the red led blinks slowly and the camera opens the Wi-Fi **HM-xxxxxx**.
2. Connect it to the home Wi-Fi with the *ESP SoftAP Prov* app (proof of possession `hm-setup`), or over USB:
   `{"cmd":"wifi","ssid":"<network>","password":"<password>"}`
3. Point it at the server once: `{"cmd":"server","url":"wss://<server>/device/socket"}` (the default is `ws://10.0.1.99:8790/device/socket`).
4. The led blips every 3 s when it is connected. Approve it in the app under **Devices**.

Power cycling the camera three times within 10 s each forgets the Wi-Fi and starts provisioning again.

### Server and app

```sh
npm install
npm run build
npm test
cp .env.example backend/.env                     # fill in, plus PORT and MONGODB_URI
node backend/dist/app.js                         # http://localhost:8790
```

Without hardware: `npx tsx backend/scripts/simulate-device.ts ws://localhost:8790/device/socket` connects a camera that sends generated frames with a box walking through every 30 s.

Deployment to jhubuntu: [docs/deployment.md](docs/deployment.md).

## Debugging

The serial port (115200 baud) prints every module's output with time, file, line and task:

```
    0.229 |      IC_camera.c:83  |       main | camera: OV2640 ready
```

`{"cmd":"debug"}` switches it off and on (kept across restarts), `{"cmd":"info"}` prints the device state, including the url of the local stream page with its key. All commands: [docs/protocol.md](docs/protocol.md#serial-commands-usb-115200-baud).

| Red led              | Meaning                      |
| -------------------- | ---------------------------- |
| slow blink (1 Hz)    | waiting for Wi-Fi provisioning |
| fast blink (5 Hz)    | connecting to Wi-Fi or server |
| short blip every 3 s | connected to the server      |
| double blink         | no camera found              |

## Documentation

* [docs/architecture.md](docs/architecture.md): modules of firmware, server and app, and what comes next
* [docs/protocol.md](docs/protocol.md): the device protocol, for new device types too
* [docs/deployment.md](docs/deployment.md): jhubuntu, reaching it from home, firmware updates
* [hardware/](hardware/README.md): printed parts; the feeder's [iris valve](hardware/feeder/iris/README.md)
