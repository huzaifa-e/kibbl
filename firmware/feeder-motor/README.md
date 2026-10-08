# Feeder motor

The motor control of the feeder iris (`hardware/feeder/iris`): an Arduino Nano gives STEP/DIR to a BTT S42B closed-loop driver on the NEMA 17, and takes commands over USB serial. Everything below is the setup that was tested on 2026-10-08: the iris closed fully and opened fully at 2400 steps/s.

## Hardware

| Part | What it is |
| --- | --- |
| Controller | Arduino Nano clone: ATmega328P, CH340 USB serial, **old bootloader** (uploads at 57600) |
| Driver | BIGTREETECH S42B v1.0 on the back of the motor: STM32F030, 2 × A4950, TLE5012B magnetic encoder, removable OLED, 4 buttons, 4 DIP switches |
| Motor | NEMA 17, 17HS4401 (1.7 A rated), 5 mm D-shaft into the 15 T pinion |
| Supply | 12-24 V on the S42B's VIM; the Nano on USB |

### Wiring (Nano → S42B signal header)

| Nano | S42B | |
| --- | --- | --- |
| D9 | CLK (STEP) | 50 µs pulses from Timer1 |
| D5 | DIR | high or low by `invert` |
| D10 | EN | held low: enabled at EnablePin `!Enable`; high for 0.12 s to find the zero |
| GND, 5V | GND, COM | as wired for the samgas NEMA 17 demo, unchanged |

The pins are the ones of `samgas-nema17-demo/stepper_motor_controller`, which ran the same motor and driver first. D7/D8 are not wired.

## S42B settings

### DIP switches (set with the power off)

| Switch | Setting | Why |
| --- | --- | --- |
| 1 | ON | microsteps at the first start; the menu value counts afterwards |
| 2 | OFF | |
| 3 | ON | closed loop |
| 4 | **OFF** | ON only to calibrate: an uncalibrated S42B with 4 ON calibrates at every power-up, and turns a whole turn each way |

### Menu (OLED)

K1 reset · K2 next line · K3 between status and settings · K4 confirm.

| Item | Setting | Notes |
| --- | --- | --- |
| Calibrate | done once, shaft free | see below |
| Motor mA | **1200** in the test; **800** recommended | the motor gets **half** of the value (S42B manual): 1200 is 0.6 A, 800 is 0.4 A. Above 800 a jammed kibble can crack a drive pin (iris README, Loads) |
| Microstep | **16** | on the S42B that is **4096 steps a turn**, not 3200 |
| EnablePin | **!Enable** (default) | enabled while EN is low; the Nano holds D10 low. At `Enable` the motor stays off |
| DirPin | default | the direction is set on the Nano (`invert`) |

The status screen shows `Simp` (rpm), `Err` (degrees behind the target) and `Deg` (target angle). `Deg` changes with every step the board receives: if it stays still while the Nano moves, no steps arrive.

### Calibration

Needed once per motor and board, and again after the magnet or the board was moved.

1. Power off. Take the pinion off the shaft: calibration turns the motor a whole turn each way, the iris only allows 157.5°.
2. DIP 3 ON, DIP 4 ON. Power on (12-24 V on VIM), wait 2 s, do not touch the shaft.
3. K3 → K2 to `Calibrate` → K4. The LED flashes twice, the motor steps slowly 200 full steps one way and 200 back (1-2 min).
4. At `Calibrate finished! Please press Reset Key reboot`: K1.
5. Power off, DIP 4 OFF. At the next start it shows `Calibration OK!`.
6. Set Motor mA, Microstep, EnablePin as above.

If the LED flashes 10 times instead, the encoder sees no magnet: it has to sit centred on the end of the motor shaft, 2-4 mm from the chip.

## Nano settings

Kept in EEPROM, changed with `config` (below); the defaults in the sketch are the tested ones.

| Setting | Value | |
| --- | --- | --- |
| `speed` | 2400 steps/s | 35 rpm at the motor: closed in 1.6 s (with the nudge), open in 1.1 s |
| `accel` | 8000 steps/s² | above 2400 steps/s the stroke is too short to gain much |
| `invert` | false | `move 400` from open closes the iris |
| `opening` | 22 mm | of a feed portion |
| `openMs` | 1000 ms | how long a portion stays open |

Fixed in the sketch:

| | Steps | |
| --- | ---: | --- |
| Fully open | 0 | the open end of the ring slots; set with `zero` |
| Stroke | 1792 | 157.5° of motor at 4096 a turn (5:1 to the ring, 31.5° of the ring) |
| Closed | 1782 at first, then **taught** | where a closing run was stopped under load (`closedPos`, kept in EEPROM) |
| Nudge | 76 | after closing: open this far and close again, frees kibble caught between the blades |
| Home overtravel | 410 | how far a full open drives past 0 into the open stop (a tooth of the pinion is 273) |

The opening at each step comes from `iris.py` (`OPENING_TABLE`, 15 points over the stroke).

The position is saved in EEPROM after every move, so it survives a reset. The S42B tells nothing back (no position, no stall), and under load the pinion can slip on the shaft or skip a tooth: the count then no longer matches the iris and it stops short of open.

### Teaching the limits under load

With kibble in the hopper the iris does not reach the empty stops. In the app (feeder card → Tuning → Teach the loaded limits), or over serial:

1. **Run opening** (`run open`) and **Stop** (`stop`) at fully open: where it rests becomes 0, the open limit; the closed limit keeps its place.
2. **Run closing** (`run close`) and **Stop** at closed: that is the closed limit, if it is 300-4000 steps from 0.

A run goes at full speed (4000 steps/s, 20000 steps/s²) until Stop, and ends by itself, braked and teaching nothing, after 30 s. Stop takes no braking ramp: no more steps from the moment it arrives, the S42B brings the shaft to rest.

`close`, `open`, the slider and the feeding levels then work between the two: the opening table of the design is stretched over them. Teach again when the load or the mechanics change.

### Finding the zero with EN

`home` (Find the zero in the app) drives a whole stroke towards open and 410 steps past it into the open stop at 800 steps/s, where the S42B pushes against the stop; then EN goes high for 0.12 s. The S42B takes the angle its encoder reads as its new target when it is disabled (`PID_Cal_value_init` in its firmware), stops pushing and holds there once enabled: that is 0. This needs the EN wire (D10); "Motor off for 10 s" shows whether it is there. `zero` is still there for setting up by hand.

## Commands

USB serial, 115200 baud, one line each, json as in `docs/protocol.md` or plain words. A command that moves answers when the move is done, with the position.

| Json | Words | |
| --- | --- | --- |
| `{"cmd":"feed","portions":2,"id":1}` | `feed 2` | open to `opening`, wait `openMs`, close with the nudge; 1-10 portions; `opening` and `openMs` in the json for this feed only; ends with `{"type":"event","event":"fed"}` |
| `{"cmd":"open","mm":30}` | `open 30` | to an opening of 2-42 mm between the taught limits, `open` alone fully |
| `{"cmd":"run","dir":"close"}` | `run close` | turns until `stop`; that stop is taught as the closed limit (`run open`: as 0) |
| `{"cmd":"release","ms":5000}` | `release 5000` | the motor off for a while (EN high): it turns by hand |
| `{"cmd":"close"}` | `close` | |
| `{"cmd":"move","steps":-50}` | `move -50` | relative, no limits: for setting up |
| `{"cmd":"zero"}` | `zero` | here is fully open |
| `{"cmd":"home"}` | `home` | a whole stroke towards open into the stop, the zero there: from wherever the iris is |
| `{"cmd":"stop"}` | `stop` | |
| `{"cmd":"info"}` | `info` | position, opening, settings |
| `{"cmd":"feeder_config","speed":2400}` | `config speed 2400` | any of `opening`, `openMs`, `speed`, `accel`, `invert` |

## In the app

The Nano has no network: `tools/feeder-bridge` on the computer it is plugged into connects it to the server as a kibbl. feeder. The feeder is online in the app while the bridge runs and the Nano answers; unplugged, it goes offline and the bridge waits for it.

```bash
cd tools/feeder-bridge && npm install          # once
npx tsx bridge.ts                              # wss://kibbl.tail529b44.ts.net/device/socket, the only usbserial port
npx tsx bridge.ts wss://…/device/socket /dev/cu.usbserial-11210
```

The first time it shows up as a new device under Devices for the admin to approve; its id and secret are kept in `.feeder-bridge.json` where it runs. Its card has the opening as a slider (closed to 42 mm), Close and Open, and the feeding levels of `shared/protocol.ts`:

| Level | Portions | Opening | Open |
| --- | ---: | ---: | ---: |
| Snack | 1 | 15 mm | 0.6 s |
| Small | 1 | 22 mm | 1 s |
| Medium | 2 | 22 mm | 1 s |
| Large | 3 | 30 mm | 1.5 s |

The bridge asks the port for its line state every 50 ms: with Node 26 and serialport 12 on macOS the Nano's answers otherwise wait in the driver until the next write.

## Build and upload

The Arduino AVR tools are Intel builds: on an Apple Silicon Mac they need Rosetta (`softwareupdate --install-rosetta --agree-to-license`).

```bash
arduino-cli compile --fqbn arduino:avr:nano:cpu=atmega328old firmware/feeder-motor
arduino-cli upload  --fqbn arduino:avr:nano:cpu=atmega328old -p /dev/cu.usbserial-XXXX firmware/feeder-motor
```

The port number changes with the USB socket (`ls /dev/cu.usbserial-*`). Opening the port resets the Nano; the bootloader waits about 2 s before the sketch answers.

What was on the Nano before is saved in `~/Documents/Arduino/backups/nano-before-feeder-motor.hex`:

```bash
avrdude -c arduino -p m328p -P /dev/cu.usbserial-XXXX -b 57600 -U flash:w:nano-before-feeder-motor.hex:i
```

## When it does not move

| Symptom | Cause |
| --- | --- |
| buzzes, `Deg` does not change | no steps arrive: wrong pins (CLK D9, DIR D5), or the S42B disabled (EnablePin against the EN level) |
| buzzes, `Deg` changes, the shaft does not turn | not calibrated, or the magnet off centre |
| buzzes in bursts at power-up | DIP 4 ON on an uncalibrated board: it calibrates, with the pinion on it runs into the stops. Power off, pinion off |
| turns slowly | `speed` too low; `Err` growing while it moves means the motor lags: more Motor mA |
| turns the wrong way | `config invert true` |
| opens short of 42 mm, or closes into the stop | the zero moved (pinion slipped, tooth skipped): `open` (fully) or `home` finds it. If it keeps moving: tighten the grub screw on the shaft's flat |
