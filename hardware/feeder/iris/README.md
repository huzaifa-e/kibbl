# Feeder iris (NEMA 17)

The portioning valve of the cat feeder: kibble rests on six blades under the hopper, a NEMA 17 turns the ring gear and the blades swing open like a camera aperture. How far and how long the iris opens decides how much falls into the bowl.

![The iris from above: open, partly open, closed](images/iris-top.png)

| | |
| --- | --- |
| Opening | 42 mm open, 2 mm closed (kibble is 8-12 mm) |
| Drive | NEMA 17 → 15 T pinion → 75 T ring gear (5:1, module 1.5) |
| Stroke | ring 31.5°, motor 157.5°, **1400 microsteps** at 1/16 from open to closed |
| Size | Ø 130 mm, 16 mm high without the funnel; the motor hangs 40 mm below, beside the outlet |
| Blades | 6 × 1.2 mm, at most two stacked anywhere, in a 3 mm cavity |

![Exploded view](images/iris-exploded.png)

## Files

| File | |
| --- | --- |
| `iris.py` | the design: every dimension is a parameter at the top |
| `stl/*.stl` | parts lying in their print orientation, ready for the slicer |
| `step/*.step` | parts in their assembled place, and `assembly.step`, for Fusion, Onshape, FreeCAD |
| `render.py` | the two pictures above |

```bash
pip install -r ../../requirements.txt
python iris.py --check      # kinematics only
python iris.py              # check, then STEP + STL
python render.py
```

`--check` refuses to export a design that does not work: it verifies on the blade outline itself that the open blades stay out of the aperture, that the closed stop leaves at most 3 mm, that never more than two blades overlap (the cavity height), that the blades stay inside the housing, that no blade ever covers another blade's pins, and that the ring slots push the pins at a pressure angle below 55°. Interference of the solids was checked with every part pair at five positions over the stroke: none.

### Editing in Fusion

Open `step/assembly.step` (File → Open, or upload to a Fusion project): every part comes in as a body in its place. Add a revolute joint on the ring to see the stroke. Changes made there do not flow back into `iris.py`; when the design moves to Fusion for good, export the `.f3d` and the STEP files into `fusion/` here and treat those as the source.

## Parts

| Part | Qty | Material | Notes |
| --- | --- | --- | --- |
| `base.stl` | 1 | PETG | floor on the bed, 3 walls, 30 % infill |
| `blade.stl` | 6 | PETG or PLA | 0.2 mm layers (6 layers), 100 % infill, smooth bed side down |
| `ring.stl` | 1 | PETG | 4 walls, 40 % infill; the teeth carry the load |
| `pinion.stl` | 1 | PETG | 100 % infill |
| `lid.stl` | 1 | PETG/PLA | plate on the bed, sleeve up |
| `funnel.stl` | 1 | PLA | flange on the bed |

PETG is the usual choice for the parts the kibble touches (funnel, lid sleeve, blades, base bore).

| Hardware | Qty | |
| --- | --- | --- |
| NEMA 17 stepper, 5 mm D-shaft ≥ 20 mm (e.g. 17HS4401) | 1 | |
| Stepper driver, TMC2209 (BTT) | 1 | sensorless homing on the hard stops, quiet |
| M3 × 8 socket head | 4 | motor, from the top through the counterbores |
| M3 × 16 | 6 | funnel + lid into the base (self-tapping into 2.8 mm holes) |
| M3 × 6 grub screw | 1 | pinion onto the shaft flat |
| 12 V supply, ≥ 1 A | 1 | |

## Assembly

1. Screw the motor to the underside of the base: shaft up through the 22 mm hole, 4 × M3 × 8 from the top.
2. Put the six blades on the pivot pins, drive pins up, all folded outwards (open), each blade's tip lying on top of the next blade counter-clockwise; tuck the last one under the tip of the first.
3. Turn the ring clockwise as far as the slots allow (open) and lower it onto the ledge so every drive pin drops into its slot.
4. Push the pinion onto the shaft, flat towards the grub screw, mesh it with the ring, tighten the grub screw on the flat.
5. Lid on top (sleeve down into the ring), funnel on the lid, 6 × M3 × 16 through both into the base.
6. Turn the motor by hand: the iris must close and open without a catch. The chute to the bowl is part of the feeder stand, it fits under the 42 mm outlet. A blade that rides up: sand its edge, or raise `CAVITY` by 0.2 mm.

## Motion

Seen from above the ring turns counter-clockwise to close, so the motor turns clockwise. The slot ends are the hard stops at fully open and fully closed.

| Motor microsteps from open (1/16) | Ring / blade swing | Opening |
| ---: | ---: | ---: |
| 0 | 0° | 42 mm |
| 267 | 6° | 37 mm |
| 533 | 12° | 30 mm |
| 800 | 18° | 22 mm |
| 1067 | 24° | 14 mm |
| 1200 | 27° | 9 mm |
| 1333 | 30° | 4 mm |
| 1400 | 31.5° | 2 mm (closed stop) |

* **Homing**: drive towards open at low current until the TMC2209 reports a stall (StallGuard) at the hard stop, that position is 0.
* **Portions**: open to a set opening (e.g. 22 mm, 800 microsteps) for a set time, then close. Grams per second depend on the kibble; weigh a few runs once and the feeder doses by time. Closing through falling kibble needs torque: close at full current, and reopen a little and close again if a stall is reported before the closed position.
* The feeder joins the server as a device with the `feeder` capability (`docs/protocol.md`, command `{"cmd":"feed","portions":n}`).

## Parameters worth changing

| Parameter | Default | Effect |
| --- | --- | --- |
| `R_AP` | 21 | aperture radius; blades, pins and housing follow, run `--check` |
| `BLADE_T`, `CAVITY` | 1.2, 3.0 | blade thickness and the room for two of them |
| `PIVOT_HOLE_D`, `SLOT_W` | 4.0, 4.5 | fit of the pins; open by 0.1-0.2 if your printer runs tight |
| `ALPHA_MAX` | 31.5 | the closed stop; 33 closes completely but stacks three blades at the centre |
| `TEETH_RING`, `TEETH_PINION` | 75, 15 | gear ratio, the motor moves with `CENTER_DIST` |
| `SHAFT_D`, `SHAFT_FLAT` | 5.15, 4.65 | motor shaft fit |
