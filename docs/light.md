# kibbl. light

The ambient light behind the TV: its 12 V analog RGB strip (5050, pads +12V, G, R, B) on the Magic Home WiFi LED controller it came with, reflashed with `firmware/light`. The whole strip shows one colour. The app shows it as *kibbl. light*, with power, colour and brightness, and its own page (*Light*, `/light`) with moods, effects, timers and alerts; an assistant reads it with `kibbl_light` and sets it with `kibbl_light_set`.

## Hardware

| Part | |
| --- | --- |
| Controller | Magic Home WiFi LED Controller (RGB with IR), 5–28 V, max 144 W, board ZJ-WFMN-A V1.1 |
| MCU | ESP8285, 1 MB flash inside the chip, 26 MHz crystal |
| Outputs | 3 low side MOSFETs: red GPIO12, green GPIO5, blue GPIO13 (as published by ESPHome for this board; `rgb` with `order` swaps them in software) |
| IR receiver | GPIO4, not used yet |
| Flash pads (back) | TXD, RXD, GND, V33, IO0 |
| Power | 12 V adapter into V+ and GND of the controller |

## First flash

The ESP32-CAM-MB (CH340C) is the USB-UART, with the ESP32-CAM taken off. Its 3.3 V logic fits the ESP8285; the controller runs from its own 12 V, so V33 stays unconnected. The MB's sockets are named by the ESP32-CAM's silkscreen: plug the CAM in, mark the sockets, take it off, male Dupont wires into them.

| MB socket | Magic Home pad |
| --- | --- |
| U0R | RXD |
| U0T | TXD |
| GND (between IO0 and VCC) | GND |
| IO0 | IO0 |

There is no reset line: before every esptool command, hold the MB's IO0 button, plug in the 12 V, let go. If esptool does not connect, swap RXD and TXD first. Never the Arduino Nano as the adapter: its 5 V TX goes straight into the ESP8285.

1. Unplug the strip.
2. Back up the original firmware (flash mode first):
   `python3 -m esptool --port /dev/cu.usbserial-XXXX --baud 115200 read_flash 0 0x100000 magichome_backup.bin`
3. Flash mode, then `firmware/light/build.sh upload /dev/cu.usbserial-XXXX`.
4. Power the controller again without IO0. With no network stored the strip blinks blue: join the Wi-Fi `kibbl-xxxx` with a phone and choose the home network on the page that opens (or send `{"cmd":"wifi","ssid":"…","password":"…"}` over the serial port at 115200). Three green blinks: joined. The page shows the pairing code for *Devices → Add with a code*.
5. Plug the strip in. It starts warm white at 60 %; set pure red, green and blue in the app and check that the strip matches. If not, `{"cmd":"rgb","order":"grb"}` (or the order it shows) puts them right.

From then on updates come over the air (*Update all* with `firmware/light/build/main.ino.bin`); the adapter is only needed again to recover a device that cannot reach its network.

## Behaviour

* The light comes back after a power cut, faded in, as it was 3 s after its last change.
* Without the network it keeps its light; it connects again by itself.
* An update: the light breathes until the restart. The new image is checked before it is copied over the old one, a power cut during the copy starts the copy again.
* 3 crashes in a row before the server was reached: safe mode, the strip stays dark, only the network and updates run, so a fixed image can be sent. The device list shows it in the hello (`safeMode`).

## Moods, effects, timers and alerts

The server plays them (`backend/src/core/lightShow.ts`, definitions in `shared/light.ts`); the firmware only knows one colour and a fade of up to 10 s.

* **Moods**: a colour and brightness with a name (movie: a dim neutral bias light behind the screen; night light: faint red without blue; relax, focus, reading, romantic, gaming, forest), or an effect (candle, ocean, aurora, party).
* **Effects**: candle, breathe, rainbow, ocean, aurora, party run until the light is changed; with minutes they end after them and the light comes back as it was. A sunrise goes from dark red to bright warm white over its minutes and stays; a sunset goes from the light now through deep orange to off (a sleep timer). A change in the app or by an assistant ends an effect.
* **Timers**: weekly, home time, each does off, a mood, a colour or an effect. A sunrise is bright at its time and starts its minutes before. Checked every 20 s.
* **Alerts**: the alerts of `core/notify.ts` that name a kind flash the owner's lights in its colour (fire red, window blue, air hints yellow, cat magenta, feeder problem orange, assistant cyan), then the light is put back and an effect goes on. Quiet hours (23 to 7 at first) hold all but a fire; *only while on* leaves a dark room dark, again but for a fire.

**The flash of the controller.** The device stores its light 3 s after the last change, and each store erases a flash sector. An effect therefore never holds a step for longer than 2.5 s: a slow fade is cut into pieces of at most 2.5 s, so the light is stored once, when the effect is over. Keep it so for new effects (`lightShow.test.ts` checks every effect).

Assistant tools: `kibbl_light_mood`, `kibbl_light_effect` (also `stop`), `kibbl_light_flash` (flash a colour to tell the person something), `kibbl_light_plan` (timers, alerts, what plays), `kibbl_light_timer_set` (add, change, remove, run now), `kibbl_light_alerts_set`.

## TV sync (next)

HyperHDR on the Raspberry Pi 3 with an HDMI splitter and a USB grabber averages the picture into one colour; the light will take it as WLED's realtime UDP protocol (port 21324), so HyperHDR's WLED device works unchanged.
