# PetKit feeder

kibbl. reads and feeds a PetKit Fresh Element Solo (PetKit's `d4`, also the `d4h`) through PetKit's cloud, with the same requests as PetKit's Android app (taken from [pypetkitapi](https://github.com/Jezza34000/py-petkit-api), which Home Assistant's PetKit integration uses). Code: `backend/src/petkit/`, `shared/petkit.ts`, `frontend/src/script/petkitCard.ts`.

## Connecting

Devices page → *Pet feeder · PetKit*: e-mail, password and region of a PetKit account.

- **Use a second account.** PetKit keeps one session per account; a sign-in elsewhere ends the other one (error 5). With the phone's account, PetKit's app and kibbl. sign each other out. Register a new account with an e-mail and a password, share the feeder with it from the main account (device settings → Share), connect that one. Accounts made with Apple or Google have no password and cannot be connected.
- The password is sent to PetKit as its md5, the only form kept, encrypted with the session (AES-256-GCM, key from `HEALTH_TOKEN_KEY` or `JWT_SECRET`) in `PetkitLink`.
- The region picks PetKit's cloud via `passport.petkt.com/v1/regionservers` (Germany → `api.eu-pet.com`).

## What the server does

- Reads each feeder every minute (`d4/device_detail`, `d4/dailyFeeds` for today), every 5 s for 90 s after a command and while it feeds. The list of feeders (`group/family/list`, else `discovery/device_roster_v2` for shared ones) every 6 hours.
- Feed now (1–5 portions, `saveDailyFeed`, amount = portions × 10), stop (`cancelRealtimeFeed`), skip or restore a meal of today (`removeDailyFeed` / `restoreDailyFeed`), pause the plan (`suspendFeed` / `restoreFeed`), desiccant replaced (`desiccantReset`). The weekly plan: below.
- Tells the owner (e-mail and ntfy) when the hopper runs low, the feeder reports an error, or a meal was not given.

## Feeder page and weekly plan

`/feeder` (`?id=` for another feeder): the stream of the camera over it, today's card, and the weekly plan, one column a weekday. Saving sends all seven days.

- Read: `POST d4/feed?deviceId=` → `feedDailyList`, seven days, each with its weekday in `repeats` (1 is Sunday), `suspended` and `items` (`time` in seconds after midnight, `amount` = portions × the feeder's `settings.factor`, 10).
- Save: `POST d4/saveFeed` with the form fields `deviceId` and `feedDailyList` (JSON). Items are written as PetKit's app writes them (`amount1`/`amount2` 0, `deviceType` the family id from the device list, 11 for the d4, `id` kept for an unchanged time, else the time, `petAmount` []); the other fields of a day are kept.
- Checked like PetKit's app does: at most 10 meals a day, 5 minutes apart, 1–10 portions.
- The server logs PetKit's answer once per start (`PetKit plan as sent`), to compare when PetKit changes the format.

## Assistant (MCP)

- `kibbl_feeder`: today and the weekly plan.
- `kibbl_feeder_feed`: feed 1–5 portions now, or stop.
- `kibbl_feeder_today`: skip a meal of today's plan, or give a skipped one.
- `kibbl_feeder_schedule`: on given weekdays (`all`, `weekdays`, `weekend`, `mon`…`sun`) set, add, remove or move meals; pause or resume the plan.

## The camera over the feeder

On the devices page each feeder gets the kibbl. cam that watches it. That camera's page shows the feeder card, a cat it sees is "at the feeder" (`core/visits.ts`), and the mail says how much the feeder gave today.

*Same view as* on a camera's page (Picture card) copies another camera's resolution, quality, levels, turn, mirror, zoom and motion detection, e.g. from the old feeder cam to a new ESP32-CAM mounted on top of the Solo.
