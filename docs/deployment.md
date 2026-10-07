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

## Accounts

Anybody who reaches the app can create an account on the login page (`SIGNUP=closed` stops that). Every account has its own devices, meters and health: nobody sees another account's cameras, events, pictures or readings, in the app, the streams or the MCP tools.

- A device set up over USB in the app belongs to whoever set it up. One that belongs to an account already can be set up again only by that account; anybody else gets told to have its owner remove it first.
- A device that connects without a USB setup waits without an owner; only the admin (`ADMIN_EMAIL`) sees it, and owns it after approving it.
- A meter belongs to the account that added it; another account cannot add the same one.
- Devices and meters from before accounts had owners were given to the admin on the first start.

Forgotten passwords are reset by e-mail: *Forgot password?* on the login page sends a link valid for an hour to `APP_URL/reset`. It needs an SMTP account (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`) and `APP_URL`, the address people open the app at; without them the page says it is not available. A Gmail account works with an app password (`smtp.gmail.com`, 587). Setting a new password ends every session and every connected assistant of that account.

## Health

The health page reads a fitness tracker through the Google Health API v4 (the successor of the Fitbit Web API). It needs an OAuth client of a Google Cloud project, in `.env`:

1. In the Google Cloud console, enable the **Google Health API** (`health.googleapis.com`).
2. Create an **OAuth client ID** of type *Web application*. Its authorized redirect URI is the server as the browser reaches it plus `/api/health/google/callback`, e.g. `https://<tunnel or domain>/api/health/google/callback` (`GOOGLE_REDIRECT_URI` fixes it when the server cannot tell).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then `docker compose up -d --force-recreate app`.
4. In the app: Health, **Connect Google Health**.

Everybody else connects with the same button, no console of their own: in Testing mode their Google e-mail has to be on the app's **Test users** list first (Google Auth Platform, Audience; up to 100). The health page shows each person the steps through Google's screens, and the admin the console setup with this server's redirect URI and scopes. `GOOGLE_APP_PUBLISHED=true` tells the guides the app is published.

The tester list has no API, so the app does everything around it: a person enters their Google e-mail and taps *Request access* on the health page; the admin sees the request on the health page (and a notice on the home page, and a mail when SMTP is set up), copies the address into **Test users** (`GOOGLE_PROJECT_ID` makes the link open the right project), and taps *Done*; the person is told to connect, in the app and by mail.

While the OAuth app is in **Testing** mode, Google ends the access after 7 days (the page says when). Publishing it to **Production** makes it last, but Google then asks for a home page and privacy policy on an authorised domain. Without a domain, renew the access before it ends (the stored history is not affected by a lapse, only new data pauses):

```bash
HOST=jh@100.84.217.119 SSH_PORT=4711 ./deploy/renew-health-token.sh user@example.com
```

It opens the Google consent in the browser with whoofit's `gh_auth.py` (`WHOOFIT_DIR`, default next to this repository) and imports the new token on the server through ssh stdin; `--import-only` imports the current token without a consent, `--check` says when it ends.

To have it run by itself, install the daily job on the Mac (launchd, 9:00, or after waking):

```bash
HOST=jh@100.84.217.119 SSH_PORT=4711 ./deploy/install-health-renewal.sh user@example.com
```

It stays quiet while the token has more than 3 days left; then it shows a notification and opens the consent, which still needs one click (Google's testing mode asks a person every 7 days). An unanswered consent is given up after 2 hours and asked again the next day; a token renewed while the server was unreachable is imported on the next run. Log: `~/Library/Logs/kibbl-health-renewal.log`; `--remove` uninstalls it.

A token from whoofit (`gh_token.json`, same OAuth client) is linked to a user without a new consent:

```bash
docker exec -i kibbl-app node health-import.js user@example.com < gh_token.json
```

The token comes on stdin, never on the command line. Tokens are stored encrypted with `HEALTH_TOKEN_KEY` (or a key derived from `JWT_SECRET`): changing it means connecting again.

The health history is **stored on this server**: after connecting, the server fetches everything Google has once (the page shows how far it got; heart rate at full resolution takes the longest, ~4 requests a day of history), then only the latest data after each sync of the tracker. Disconnecting keeps the stored history, the page shows it without new data; *Delete stored history* removes it for good. It is in MongoDB (`healthpoints`, `heartratedays`), so a database backup has it too: a year is roughly 70 MB of points and 110 MB of heart rate on disk.

Every request to Google goes through one queue: `HEALTH_CONCURRENCY` (4 by default) at once for all users, pages of 10 000 points (the API's maximum), heart rate as a partial response with only the values. A 429 from Google pauses the whole queue for as long as it asks; a network error or a 5xx is tried again after 2, 4 and 8 s. A day opened on the page goes ahead of the history fetch. `/api/health/status` shows the queue (`requests.running`, `requests.waiting`).

## MCP

`/mcp` is an [MCP](https://modelcontextprotocol.io) endpoint (Streamable HTTP) that lets an AI assistant read the home's data: devices and a live camera picture, motion events and activity (and the pictures kept for them), meters with readings and consumption, and the stored health history day by day or through a day. It only reads; nothing can be changed through it. Times are the server's local time.

Access is by token, one per client, created on the server and shown once (only its hash is stored):

```bash
docker exec kibbl-app node mcp-token.js create user@example.com "laptop"
docker exec kibbl-app node mcp-token.js list
docker exec kibbl-app node mcp-token.js revoke "laptop"
```

A client is given the url (`http://<server>:8790/mcp`, on the home network or over Tailscale) and the header `Authorization: Bearer <token>`.

Whatever a tool returns goes to the model provider with the conversation, health data and camera pictures included.

### Connector for a hosted assistant (web, phone)

A hosted assistant connects from the internet and signs in with OAuth: it registers itself, sends you to a kibbl. sign-in page, and gets an access token (1 hour) and a refresh token (60 days, renewed with every use). A password change ends every connector. In the server's `.env`:

```bash
MCP_PUBLIC_URL=https://kibbl.tail529b44.ts.net               # where it is reached from the internet
MCP_REDIRECT_URIS=https://assistant.example/callback        # the assistant's OAuth callback(s), comma separated
```

Only the callbacks listed (and loopback ones, for desktop clients) can register. The public address is a device of its own on the tailnet, the `connector` service (a Tailscale container named `kibbl`), with Funnel on port 443 publishing the whole app (`deploy/tailscale/serve.json`): the pages, the devices' socket, `/mcp` and its OAuth; hosted assistants reach port 443 only. It is the server's fixed https address, so `APP_URL`, `DEVICE_BASE_URL` and `GOOGLE_REDIRECT_URI` point to it too. jhubuntu's own name stays as it is: its 443 belongs to emoni-lorawan. The first start needs an auth key (Tailscale admin console, Settings, Keys); the login is kept in `data/tailscale` after that, and deploys leave the container running:

```bash
read -rs TS_AUTHKEY && export TS_AUTHKEY && docker compose --profile connector up -d connector; unset TS_AUTHKEY
docker compose logs connector | tail
```

In the admin console, switch off key expiry for the new `kibbl` device, or the address stops working after 180 days.

The connector is added in the assistant's settings with the url `https://kibbl.tail529b44.ts.net/mcp`. `mcp-token.js list` shows signed-in connectors next to the tokens, `mcp-token.js revoke <name>` ends one.

## Meters

Meters (electricity, gas, water) come from the EMONI LoRaWAN server running on the same host (`ttn-chirpstack-webhook`, container `emoni-lorawan`). The app joins its docker network (`METER_SOURCE_NETWORK`, default `ttn-chirpstack-webhook_default`, which must exist before `docker compose up`) and reads its api at `METER_SOURCE_URL` (default `http://emoni-lorawan:8000`); it only reads.

A meter is one of the source's configured devices, by its uuid: in `.env` as `METERS=<uuid>,<uuid>` (added on start), or on the Devices page, **Add meter**. The first sync copies its whole history (12,000 readings take a few seconds); after that the app listens to the source's live stream and fetches a reading as soon as the meter sends it (after a lost connection it reconnects and catches up). The copy is in MongoDB (`meterreadings`, `meterperiods`), so the page keeps working while the source is down; removing a meter (Devices) deletes its copy, not the source's data.

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
