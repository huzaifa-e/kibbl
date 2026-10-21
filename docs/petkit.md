# PetKit feeder

kibbl. reads and feeds a PetKit Fresh Element Solo (PetKit's `d4`, also the `d4h`) through PetKit's cloud, with the same requests as PetKit's Android app (taken from [pypetkitapi](https://github.com/Jezza34000/py-petkit-api), which Home Assistant's PetKit integration uses). Code: `backend/src/petkit/`, `shared/petkit.ts`, `frontend/src/script/petkitCard.ts`.

## Connecting

Devices page → *Pet feeder · PetKit*: e-mail, password and region of a PetKit account.

- **Use a second account.** PetKit keeps one session per account; a sign-in elsewhere ends the other one (error 5). With the phone's account, PetKit's app and kibbl. sign each other out. Register a new account with an e-mail and a password, share the feeder with it from the main account (device settings → Share), connect that one. Accounts made with Apple or Google have no password and cannot be connected.
- The password is sent to PetKit as its md5, the only form kept, encrypted with the session (AES-256-GCM, key from `HEALTH_TOKEN_KEY` or `JWT_SECRET`) in `PetkitLink`.
- The region picks PetKit's cloud via `passport.petkt.com/v1/regionservers` (Germany → `api.eu-pet.com`).

## What the server does

- Reads each feeder every minute (`d4/device_detail`, `d4/dailyFeeds` for today), every 5 s for 90 s after a command and while it feeds. The list of feeders (`group/family/list`, else `discovery/device_roster_v2` for shared ones) every 6 hours.
- Feed now (1–5 portions, `saveDailyFeed`, amount = portions × 10), stop (`cancelRealtimeFeed`), skip or restore a meal of today (`removeDailyFeed` / `restoreDailyFeed`), pause the plan (`suspendFeed` / `restoreFeed`), desiccant replaced (`desiccantReset`). The plan itself is edited in PetKit's app.
- Tells the owner (e-mail and ntfy) when the hopper runs low, the feeder reports an error, or a meal was not given.

## The camera over the feeder

On the devices page each feeder gets the kibbl. cam that watches it. That camera's page shows the feeder card, a cat it sees is "at the feeder" (`core/visits.ts`), and the mail says how much the feeder gave today.

*Same view as* on a camera's page (Picture card) copies another camera's resolution, quality, levels, turn, mirror, zoom and motion detection, e.g. from the old feeder cam to a new ESP32-CAM mounted on top of the Solo.
