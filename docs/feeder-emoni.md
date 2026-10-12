# kibbl. feeder on the EMONI board

The EMONI main board **EHW0014-0011** (the version without the buzzer) replaces the Arduino Nano, the feeder bridge and the separate kibbl. cam. It keeps its own parts:
- its ESP32-S3 joins the home Wi-Fi itself;
- its camera looks at the iris;
- its illuminator LEDs light the iris;
- its green LED shows the status.

The S42B motor driver takes STEP, DIR and EN from three test pads the feeder has no other use for. The firmware is the kibbl. cam firmware (`firmware/cam`) built for this board. The motor control is `firmware/feeder-motor` ported to the ESP32 (`KL_feeder.c`). In the app the board is a **kibbl. feeder**: a camera card with the feeder's controls under it.

Schematic: `(21) Hardware/enny-hardware-ehw0014/EHW0014-0011/EHW0014-0011.sch.pdf`, sheet 3.

## Wiring

All the pads are labelled test pads on the **bottom** of the board.

| S42B signal header | EMONI test pad | ESP32-S3 | Why this pad |
| --- | --- | --- | --- |
| CLK (STEP) | **BAT_READ** | IO15 | VBAT.READ, 100 k to GND: low while booting, no stray step |
| DIR | **BAT_LEVEL** | IO9 | VBAT.EXT, 330 k to GND |
| EN | **EN.EXT** | IO8 | the USB-present divider (100 k / 150 k from USB 5 V) holds it high: the motor stays off until the firmware knows the position |
| COM | **+3V3** | 3.3 V | the inputs are driven low from 3.3 V, as the Nano drove them from 5 V |
| GND | GND, e.g. pin 2 of JP1 or JP2, or GND of the programming header | GND | as with the Nano |

These pads used to measure the battery and detect USB, which the feeder doesn't need. Leave the batteries out.

**COM must go to +3V3, not to 5 V.** Each S42B input is on while its pin pulls it below COM. With COM on 5 V, a pin at 3.3 V would still leave about 1.7 V across the input: the input would never switch off, and the motor would not step.

Unchanged:
- **Illuminator LEDs:** on JP1 or JP2, switched by LED.0 (IO19).
- **Board power:** the USB-C socket, 4.4–5.25 V. A 5 V supply is enough; the board's USB-C has no data lines.
- **S42B power:** 12–24 V on its VIM, separate from the board. Its settings stay as in `firmware/feeder-motor/README.md`.

### Pins the firmware uses

| Function | Pin | |
| --- | --- | --- |
| Camera power | IO10 (CAM_PWR) | low: on (P-MOSFET Q1) |
| Camera | XCLK 11, SDA 1, SCL 2, D0–D7 21 48 38 47 14 12 39 40, VSYNC 42, HREF 41, PCLK 13 | The sensor is a GC2145, which has no jpeg encoder: the driver keeps the Y of its YUV (grayscale, as ESW0009) and the firmware encodes it with Espressif's `esp_new_jpeg` (`CAM_SOFT_JPEG`). Always 800 × 600, the whole field of view (the driver halves the 1600 × 1200 sensor; smaller sizes crop its middle). About 4 fps: a frame every ~250 ms at 10 MHz XCLK, encoding (~120 ms) overlaps. 16 and 20 MHz cut frames short (the driver copies them with the CPU), and the driver's PSRAM DMA (`CAMERA_PSRAM_DMA`) garbles raw frames in esp32-camera 2.1.8. Flipped vertically by default (`CAM_DEFAULT_VFLIP`). Quality is the encoder's; contrast, brightness and saturation do nothing. PSRAM at 80 MHz, 32 KB instruction and 64 KB data cache, QIO flash |
| Status LED | IO17 (LED.1, green D5) | low: on |
| Red LED | IO18 (LED.2, D4) | kept off |
| Illuminator | IO19 (LED.0, FLASH) | low: on, PWM. **Turns on by itself** when something comes close (`CAM_AUTO_LIGHT`, `KL_light.c`): the middle of the frame darker than 50 of 255 for 3 frames. Every 8 s it looks with the light off for half a second (those frames are not streamed); no longer dark: off. Still dark with the light on: nothing close (night), off until the scene was brighter. On in the app stays on; off in the app keeps it out for a minute. It works while frames are taken (someone watching) |
| STEP, DIR, EN | IO15, IO9, IO8 | see the wiring above |
| Free | IO4–IO7, IO20 (the buzzer's, not fitted), IO16 (button) | IO4–IO7 only on the module's own pads |

## Build and flash

The EMONI build has its own sdkconfig and build directory, next to the camera builds:

```sh
source firmware/env.sh
cd firmware/cam
B=~/esp/builds/kibbl-feeder
idf.py -B $B -D SDKCONFIG=$B/sdkconfig -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.emoni" set-target esp32s3   # once
idf.py -B $B -D SDKCONFIG=$B/sdkconfig -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.emoni" build
idf.py -B $B -D SDKCONFIG=$B/sdkconfig -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.emoni" -p /dev/cu.usbserial-XXXX -b 460800 flash monitor
```

**Flashing:** use the programming header (TX, RX, IO0, CHIP_PU, GND) with the EMONI programming adapter. **Discard after a build:** the esp32s3 build rewrites `firmware/cam/dependencies.lock` (`git checkout firmware/cam/dependencies.lock`).

**Project name:** the image is called `KIBBL-FEEDER`, the camera's `KIBBL-FW`. The server keeps the two products' updates apart by that name. A build of the EMONI board without `sdkconfig.defaults.emoni` stops with an error.

## First start

1. Set up the Wi-Fi as for a kibbl. cam. In the app, approve the new **kibbl. feeder**.
2. **Settings:** the firmware starts with the Nano's tested ones: 2400 steps/s, 8000 steps/s², closed limit 2092 steps. They are kept in the board (NVS). Change them in the app under Tuning.
3. **Position:** the board doesn't know where the iris stands at its first start: it assumes open (0). Run **Find the zero** once before the first feed.
4. **Check the stepping:** the S42B's screen shows `Deg`, its target angle. It must follow every move. If it doesn't, the inputs don't switch at 3.3 V: check COM on +3V3. A 74AHCT125 buffer from 5 V is the way out.

## What it does like the Nano

- The same jobs: feed with the nudge, open, close, find the zero, teaching runs, steps by hand, motor off for a while.
- The same opening table, and the motor off at the closed limit.
- The position is saved after every move.
- While the iris moves, the board sends its state every 150 ms, as the bridge did, so the app's iris follows the real one.
