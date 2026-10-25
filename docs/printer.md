# 3D printer (Bambu Lab)

A Bambu Lab printer (X1, P1, A1) at home, shown in the app through the kibbl. cam on the same network. The server stays where it is: the cam logs into the printer on the home network and passes its state on in its own telemetry, commands come back the same way. Nothing on the home network is opened to the outside.

```
printer ◀── mqtts :8883 (LAN) ── kibbl. cam ── wss (out) ──▶ server ◀── app
```

The app shows the printer on the camera's page (*Controls*) and as a card of its own on the home page: state, the print with its progress, layer and the time it ends, nozzle, bed and chamber temperatures, the AMS spools (the one printing outlined), the printer's health messages (HMS codes), pause, resume, stop (a second tap), the chamber light and the speed (silent, standard, sport, ludicrous). A print that finishes or fails alerts the owner (ntfy, `core/notify.ts`). An assistant reads it with `kibbl_devices` (`printer`).

## Setting it up

1. On the printer's screen: the **IP address** and the **access code** under Settings → Network (LAN), the **serial number** under Settings → Device. A fixed address for the printer in the router keeps it from moving.
2. In the app, the camera's page → *Add a 3D printer*: the three, *Connect*. The access code goes to the cam and stays there (nvs); the server neither stores nor logs it, the app never shows it again (left empty when saving, it stays).
3. *Remove printer* forgets it, a factory reset of the cam too.

Firmware of the printer from 2025 on (Authorization Control) takes commands from other software only in **LAN-only mode with Developer Mode** on (Settings → Network on the printer). Without it the state can still be read on many models; pause, stop, light and speed are refused by the printer. Bambu Handy reaches the printer only through Bambu's cloud, which LAN-only mode switches off; Bambu Studio and Orca Slicer still print over the LAN.

A printer accepts only a few local connections at once: the cam, a slicer and a second integration (Home Assistant) are fine, more may push one out.

## How it works (`firmware/cam/main/KL_printer.c`)

`CONFIG_KIBBL_PRINTER`, on for the AI-Thinker ESP32-CAM, off on the EMONI feeder. esp-mqtt to `mqtts://<host>:8883`, user `bblp`, the access code as the password, subscribed to `device/<serial>/report`; right after connecting a `pushall` asks for everything, after that the X1 sends all of it about every second, the P1 and A1 only what changed, so the fields are kept and each report overwrites what it has. A report longer than the 4 kB buffer comes in pieces and is put together in PSRAM (64 kB at most). The printer's certificate is its own, signed by Bambu's CA: it is not checked (`ESP_TLS_SKIP_SERVER_CERT_VERIFY`, which esp-tls applies only to a connection that brings no certificate; the server's and the updates' are checked against the bundle as before). A change of state, layer, percent, light, speed, error or spool sends the telemetry at once, the temperatures go with the one every 10 s. An update stops the connection first, its TLS memory goes to the download.

| Request to the printer | Topic `device/<serial>/request` |
| --- | --- |
| everything once | `{"pushing":{"sequence_id":"1","command":"pushall","version":1,"push_target":1}}` |
| pause, resume, stop | `{"print":{"sequence_id":"2","command":"pause","param":""}}` |
| speed | `{"print":{"sequence_id":"3","command":"print_speed","param":"2"}}` |
| chamber light | `{"system":{"sequence_id":"4","command":"ledctrl","led_node":"chamber_light","led_mode":"on","led_on_time":500,"led_off_time":500,"loop_times":0,"interval_time":0}}` |

What the server makes of it: `core/printer.ts` (each field checked, the redraws, the alert when a print goes from printing or paused to finished or failed; a camera that just connected says nothing about a print that ended meanwhile).

## Not yet

* The printer's camera (X1: RTSPS on 322, P1/A1: jpeg frames over TLS on 6000).
* A history of the prints.
* Starting a print (the file goes to the printer over FTPS first).
