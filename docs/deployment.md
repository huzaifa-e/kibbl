# Deployment

The server runs on **jhubuntu** (`ssh jhubuntu`, `jh@10.0.1.99:4711`, on Tailscale `100.84.217.119`) with docker compose: the app on port **8790** and MongoDB without a published port. Data stays in `~/kibbl/data/` on the server.

## First deployment

```bash
./deploy/deploy.sh
```

The first run copies the repository and creates `~/kibbl/.env` with a random `JWT_SECRET`, then stops. On the server, set:

* `ADMIN_EMAIL`, `ADMIN_PASSWORD`: the first account (only created while there is none)
* `DEVICE_BASE_URL`: the server as the cameras reach it, for firmware downloads and as the address the app writes into a device set up over USB (`DEVICE_SOCKET_URL` overrides the latter)
* `COOKIE_SECURE=true` once the app is served over https

Then run `./deploy/deploy.sh` again. Away from the office, over Tailscale: `HOST=jh@100.84.217.119 SSH_PORT=4711 ./deploy/deploy.sh`. Every later run updates the code and restarts the app; `.env` and `data/` are never touched.

## Logs

```bash
docker compose logs -f app            # the server, live
docker compose logs --since 1h app    # the last hour
docker compose logs app | grep C82E1824CFA8    # one device
```

One line per event, columns separated by `|`, in the server's time (Europe/Berlin):

```
2026-10-06 10:28:17.200 | INFO  | db       | connected to MongoDB
2026-10-06 10:28:21.843 | INFO  | device   | connected                                | device=C82E1824CFA8 ip=192.168.0.243
2026-10-06 10:28:22.105 | INFO  | device   | hello                                    | device=C82E1824CFA8 model=kibbl-cam fw=KIBBL-3f2a1c0 ip=192.168.0.243 ssid=home
2026-10-06 10:31:09.552 | INFO  | motion   | movement                                 | device=C82E1824CFA8 moved=12.4% picture=none
2026-10-06 10:42:53.039 | WARN  | device   | silent, closing                          | device=C82E1824CFA8 after=35s
2026-10-06 10:43:01.552 | INFO  | auth     | logged in                                | user=a@b.de ip=100.81.234.79
```

Time, level, the part of the server (`server`, `db`, `auth`, `app` for actions taken in the app, `device`, `stream`, `motion`, `storage`, `ota`), what happened, then the details as `key=value` (quoted when a value holds spaces, quotes, `=` or `|`). An unexpected error is followed by its stack, indented. `LOG_LEVEL` in `.env` sets how much is written (`info` by default); colours are on (`LOG_COLOR=always` in `docker-compose.yml`, `never` for plain text).

MongoDB writes its log as json; `deploy/mongo/entrypoint.sh` starts it through the image's own entrypoint with each line rewritten by `deploy/mongo/log.jq` into the same columns, the MongoDB component in place of the scope (`network`, `storage`, `control`, ...). The handshake lines of each new connection of the app are dropped; an info line keeps only its plain values, without MongoDB's internal file and build names; a warning or error keeps its details, shortened, an error object as its message. Lines that are no MongoDB log entries, or that the filter cannot format, pass unchanged. With `--quiet` and the storage checkpoints off it logs only startups, warnings and errors. Every container keeps at most 5 × 10 MB of logs.

## Database

MongoDB runs with authentication: `admin` (`MONGO_ROOT_*` in `.env`) for people, `kibbl` (`MONGO_APP_*`, read and write on the `kibbl` database only) for the app. `deploy.sh` generates both passwords on the first deployment and an empty database creates both users on its first start (`deploy/mongo/init/`). Its port is open on jhubuntu's loopback only (`127.0.0.1:27017`), never on the network.

From a Mac with MongoDB Compass, through an SSH tunnel:

* connection string `mongodb://admin@127.0.0.1:27017/kibbl?authSource=admin&directConnection=true`
* Proxy/SSH: SSH with identity file, host `100.84.217.119` (Tailscale) or `10.0.1.99` (office), port `4711`, user `jh`, key `~/.ssh/id_ed25519`
* password: `ssh -p 4711 jh@100.84.217.119 "grep ^MONGO_ROOT_PASSWORD= ~/kibbl/.env | cut -d= -f2" | tr -d '\n' | pbcopy` copies it without showing it

On the server itself: `docker exec -it kibbl-mongo mongosh -u admin --authenticationDatabase admin kibbl` (asks for the password).

## Health

The health page reads a fitness tracker through the Google Health API v4 (the successor of the Fitbit Web API). It needs an OAuth client of a Google Cloud project, in `.env`:

1. In the Google Cloud console, enable the **Google Health API** (`health.googleapis.com`).
2. Create an **OAuth client ID** of type *Web application*. Its authorized redirect URI is the server as the browser reaches it plus `/api/health/google/callback`, e.g. `https://<tunnel or domain>/api/health/google/callback` (`GOOGLE_REDIRECT_URI` fixes it when the server cannot tell).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then `docker compose up -d --force-recreate app`.
4. In the app: Health, **Connect Google Health**.

While the OAuth app is in **Testing** mode, Google ends the access after 7 days (the page says when). Publishing it to **Production** in the console (no verification needed for scopes of your own account) makes it last.

A token from whoofit (`gh_token.json`, same OAuth client) is linked to a user without a new consent:

```bash
docker exec -i kibbl-app node health-import.js user@example.com < gh_token.json
```

The token comes on stdin, never on the command line. Tokens are stored encrypted with `HEALTH_TOKEN_KEY` (or a key derived from `JWT_SECRET`): changing it means connecting again.

The health history is **stored on this server**: after connecting, the server fetches everything Google has once (the page shows how far it got; heart rate at full resolution takes the longest, ~40 requests a day of history), then only the latest data after each sync of the tracker. Disconnecting keeps the stored history, the page shows it without new data; *Delete stored history* removes it for good. It is in MongoDB (`healthpoints`, `heartratedays`), so a database backup has it too: a year is roughly 70 MB of points and 110 MB of heart rate on disk.

## Reaching the server from the home network

The camera opens the connection itself, so the server only has to be **reachable from the home network**. 10.0.1.99 is the office LAN and is not. Choose one:

1. **Cloudflare named tunnel** (recommended): a fixed `https://home.<your-domain>`; with `DEVICE_BASE_URL=https://home.<your-domain>` the app's USB setup writes `wss://home.<your-domain>/device/socket` into every camera. Setup over USB also needs the app itself on https (Web Serial), which the tunnel gives. The certificate is checked against the ESP-IDF bundle. Set `DEVICE_BASE_URL` to the same https origin and `COOKIE_SECURE=true`.
2. **Port forward** of the office router to 10.0.1.99:8790, best with a reverse proxy doing TLS in front.
3. **Testing at home**: run the server on the laptop (`npm run build`, then `node backend/dist/app.js` with a `backend/.env`) and point the camera at `ws://<laptop-ip>:8790/device/socket`.

A quick cloudflared tunnel (random `trycloudflare.com` url, changes on every restart) works for a first test but is not suitable for a camera that must find its server after a restart. The `tunnel` service in `docker-compose.yml` runs one, apart from the app, so a deploy keeps its url:

```bash
docker compose --profile tunnel up -d tunnel
docker compose logs tunnel | grep trycloudflare.com
```

Set `DEVICE_BASE_URL` to that url (`docker compose up -d --force-recreate app`) and point every camera at `wss://<name>.trycloudflare.com/device/socket`. When the tunnel container restarts, its url changes and all of this has to be done again.

## Firmware

```bash
cd firmware
source env.sh
idf.py -B ~/esp/builds/kibbl-fw set-target esp32
idf.py -B ~/esp/builds/kibbl-fw -p /dev/cu.usbserial-XXXX -b 460800 flash monitor
```

`-B` puts the build outside the repository folder: ESP-IDF 5.1 cannot build in a path with parentheses (`(39) home-monitor`). In a checkout without them `idf.py build` works as usual. 921600 baud is too fast for the ESP32-CAM-MB adapter.

Updates after the first flash: Devices → Actions → Update firmware with `build/KIBBL-FW.bin`. A new image that resets before it reached the server or ran for 5 minutes is rolled back to the previous one.
