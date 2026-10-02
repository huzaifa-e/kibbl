# Deployment

The server runs on **jhubuntu** (`ssh jhubuntu`, `jh@10.0.1.99:4711`, on Tailscale `100.84.217.119`) with docker compose: the app on port **8790** and MongoDB without a published port. Data stays in `~/home-monitor/data/` on the server.

## First deployment

```bash
./deploy/deploy.sh
```

The first run copies the repository and creates `~/home-monitor/.env` with a random `JWT_SECRET`, then stops. On the server, set:

* `ADMIN_EMAIL`, `ADMIN_PASSWORD`: the first account (only created while there is none)
* `DEVICE_BASE_URL`: the server as the cameras reach it, for firmware downloads
* `COOKIE_SECURE=true` once the app is served over https

Then run `./deploy/deploy.sh` again. Every later run updates the code and restarts the app; `.env` and `data/` are never touched.

## Reaching the server from the home network

The camera opens the connection itself, so the server only has to be **reachable from the home network**. 10.0.1.99 is the office LAN and is not. Choose one:

1. **Cloudflare named tunnel** (recommended): a fixed `https://home.<your-domain>`; set the camera's server to `wss://home.<your-domain>/device/socket` with `{"cmd":"server","url":"…"}` over USB. The certificate is checked against the ESP-IDF bundle. Set `DEVICE_BASE_URL` to the same https origin and `COOKIE_SECURE=true`.
2. **Port forward** of the office router to 10.0.1.99:8790, best with a reverse proxy doing TLS in front.
3. **Testing at home**: run the server on the laptop (`npm run build`, then `node backend/dist/app.js` with a `backend/.env`) and point the camera at `ws://<laptop-ip>:8790/device/socket`.

A quick cloudflared tunnel (random `trycloudflare.com` url, changes on every restart) works for a first test but is not suitable for a camera that must find its server after a restart.

## Firmware

```bash
cd firmware
source env.sh
idf.py -B ~/esp/builds/home-monitor-fw set-target esp32
idf.py -B ~/esp/builds/home-monitor-fw -p /dev/cu.usbserial-XXXX -b 460800 flash monitor
```

`-B` puts the build outside the repository folder: ESP-IDF 5.1 cannot build in a path with parentheses (`(39) home-monitor`). In a checkout without them `idf.py build` works as usual. 921600 baud is too fast for the ESP32-CAM-MB adapter.

Updates after the first flash: Devices → Actions → Update firmware with `build/HOME-MONITOR-FW.bin`. A new image that resets before it reached the server or ran for 5 minutes is rolled back to the previous one.
