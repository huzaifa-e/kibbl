<p align="center">
    <h1 align="center">kibbl.</h1>
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

* **Firmware**: ESP-IDF in C, conventions of ESW0009. Wi-Fi setup from a phone (the device's own Wi-Fi with a setup page and a pairing code) or over USB, one outbound websocket to the server (works behind the home router), jpeg frames at the rate the server asks for, local stream on the home network, firmware updates over the air with rollback.
* **Server**: Node/TypeScript as in the enny-cloud-app-service. Pairs devices (trust on first use, approved in the app), relays the stream as mjpeg, detects motion and logs it as activity; a picture of each movement is kept only where the camera's settings allow it, and deleted with its event after `RETENTION_DAYS`.
* **App**: live view with snapshot and full screen, camera and light controls, motion sensitivity, quiet hours and whether pictures are kept, activity heatmap with the usual range per hour, timeline, device management with firmware upload.
* **Air**: a kibbl. air (the Conny CO2 traffic light with a new firmware) shows the CO₂ of a room on its light and in the app, gives health hints on temperature and humidity (cold, heat, dry air, mould on outer walls), counts cigarettes, notices open windows and warns of a possible fire (next to a smoke alarm, not instead of one); a lamp with fading looks and a night mode on schedule.
* **Heating**: tado connected with its own sign-in: the rooms' temperature, humidity and heating, changed from the app; rooms of the home in which devices and tado share their readings, a kibbl. air's open window switching the heating off.
* **Health**: a fitness tracker's heart rate, HRV, sleep stages, blood oxygen, breathing, temperature and workouts through the Google Health API (formerly whoofit), next to the home.

## Repository Structure

```sh
└── kibbl/
    ├── firmware/                 ESP-IDF (C), one project per product
    │   ├── components/kibbl_core/  shared: server link, commands, wifi, ota, nvs, serial;
    │   │                         KL_product.h is what a product implements
    │   ├── cam/                  kibbl. cam (ESP32-CAM, Freenove S3)
    │   │   ├── main/             camera, frames, light, local stream page (web/index.html)
    │   │   └── sdkconfig.defaults, kibbl_partition_tbl.csv
    │   ├── air/                  kibbl. air (Conny CO2 traffic light EHW0001-0013, ESP32-C3); VERSION
    │   │   └── main/             SCD30, traffic light, fan, buzzer, button, smoke and window detection
    │   ├── feeder-motor/         kibbl. feeder's iris motor for now: Arduino Nano sketch, S42B setup in its README
    │   ├── create_build_info.sh  FW_VERSION for CI builds (product, VERSION, commit)
    │   └── env.sh                ESP-IDF v5.1.6 environment
    ├── backend/                  server (TypeScript, Express, socket.io, ws, MongoDB)
    │   ├── src/core/             devices, frames, motion, auth, storage
    │   ├── src/sockets/          device websocket, browser socket.io
    │   ├── src/routes/           login, stream, snapshots, firmware
    │   └── scripts/              simulate-device.ts
    ├── frontend/                 web app (Vite, Tabler)
    │   └── src/pages, src/script
    ├── shared/                   protocol types used by both
    ├── tools/feeder-bridge/      the feeder's Arduino Nano on USB, connected to the server as a device
    ├── hardware/                 printed parts, parametric (build123d) with STEP and STL
    │   ├── camera/case/          case of the kibbl. cam: clip-ons, keyhole hanger
    │   └── feeder/iris/          NEMA 17 iris valve that portions the cat food
    ├── docs/                     architecture, protocol, deployment
    ├── deploy/deploy.sh          deployment to jhubuntu
    ├── Dockerfile, docker-compose.yml
    └── .github/workflows/        firmware and app builds
```

Module files start with KL_ (for kibbl.) to distinguish them from ESP-IDF and component sources.

## Getting Started

### Firmware

```sh
source firmware/env.sh                           # ESP-IDF v5.1.6
cd firmware/cam                                  # or firmware/air (the Conny)
idf.py set-target esp32                          # esp32s3 for the Freenove board, esp32c3 for air
idf.py menuconfig                                # kibbl. core: server url, pop; kibbl. cam: board
idf.py -p /dev/cu.usbserial-XXXX -b 460800 flash monitor
```

The Conny is flashed through the EHW0016 Tag-Connect adapter with its FlipFlop jumpers on **Off** (`(16) Programming Adapter` README), at 115200 baud.

In a folder whose path contains parentheses, add `-B <build dir outside of it>` to every `idf.py` call (ESP-IDF 5.1 quotes that path wrongly).

### Connecting the camera

**In the app** (Chrome or Edge on a computer): plug the camera in by USB, open **Devices → Set up over USB**, pick the port, name it, choose the Wi-Fi from the scan and enter the password. The app writes the network and the server address over the cable, the server approves the device on its first connection, and the dialog waits until it is online. Later Wi-Fi changes: Devices → Actions → **Wi-Fi network**; a network that does not work is undone after 30 s.

**With a phone, no cable:** a device without a network opens the Wi-Fi **kibbl-xxxx** (the red led of the camera blinks slowly, the kibbl. air blinks white). Join it with the phone: the setup page opens by itself (else `http://192.168.4.1`). Choose the home Wi-Fi and its password; once connected the page shows a pairing code. Back on the usual Wi-Fi, **Devices → Add with a code** puts the device into your account. The setup Wi-Fi closes 3 minutes after the device joined. The led of the camera blips every 3 s while it is connected.

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
    0.229 |      KL_camera.c:83  |       main | camera: OV2640 ready
```

`{"cmd":"debug"}` switches it off and on (kept across restarts), `{"cmd":"info"}` prints the device state, including the url of the local stream page with its key. All commands: [docs/protocol.md](docs/protocol.md#serial-commands-usb-115200-baud).

| Red led              | Meaning                      |
| -------------------- | ---------------------------- |
| slow blink (1 Hz)    | waiting for Wi-Fi provisioning |
| fast blink (5 Hz)    | connecting to Wi-Fi or server |
| three quick blinks   | Wi-Fi connected              |

The white flash led flashes twice when the server sees a new movement start (switch it off per camera under *Motion detection*), and five times for *Blink to find it* under Devices.
| short blip every 3 s | connected to the server      |
| double blink         | no camera found              |

## Documentation

* [docs/architecture.md](docs/architecture.md): modules of firmware, server and app, and what comes next
* [docs/protocol.md](docs/protocol.md): the device protocol, for new device types too
* [docs/deployment.md](docs/deployment.md): jhubuntu, reaching it from home, firmware updates
* [hardware/](hardware/README.md): printed parts; the [camera case](hardware/camera/case/README.md) and the feeder's [iris valve](hardware/feeder/iris/README.md)
