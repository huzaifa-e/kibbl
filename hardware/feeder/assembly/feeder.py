"""
The whole cat feeder around the iris: body with the electronics bay, chute, hopper, bowl tray.

    python feeder.py            check, then STEP and STL of every part and the assembly, into step/ and stl/
    python feeder.py --check    clearances, kibble volume, camera view, camera flex, print sizes

The iris (../iris) is used as it is: it drops into the body from above, its motor and the
BTT S42B hanging through the deck. Below the deck: the chute that carries the kibble from the
iris outlet out through the front into the bowl, and the electronics: an EMONI main board
EHW0014-0011 (without buzzer) on the inside of the front wall, its red and green LEDs and the
button showing through the wall, its camera looking down at the bowl from an "eye" above the spout.

Parts (all printed without supports):
    body        walls, deck the iris stands on, eye for the camera, board standoffs, light tubes
    floor       closes the body from below, carries the tray; everything inside is reached from here
    chute       35 deg ramp from the iris outlet out through the front wall
    shell       sleeve around the iris and funnel, holds the iris down, carries the hopper on a cone seat
    hopper      about 2.5 l: 1 kg of dry food at 0.42 g/ml; its spigot drops into the funnel collar
    hopper_lid  plug lid
    tray        in front of the body, under the bowl and the cat's front paws: keeps the bowl in the
                camera's view and the feeder from tipping forward

All dimensions in mm, z = 0 on the floor, the iris axis at x = y = 0, the bowl towards -y.
"""
import argparse
import copy
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'iris'))
import iris  # noqa: E402

# ───────────────────────────── bowl and tray ─────────────────────────────
TRAY_T = 4.0
BOWL_D, BOWL_H, BOWL_BASE_D = 150.0, 45.0, 120.0  # a usual stainless cat bowl: rim, height, foot
BOWL_GAP = 4.0  # between the body and the bowl rim
TRAY_D = 162.0  # in front of the body
TONGUE = 22.0  # the tray's tongue fills a notch in the floor this deep, under the front wall
TONGUE_W = 124.0
TRAY_SCREW_X = 40.0  # two screws from below through the tongue into bosses at the foot of the front wall

# ───────────────────────────── chute ─────────────────────────────
SPOUT_ABOVE_RIM = 14.0  # the kibble falls this far into the bowl
CHUTE_ANGLE = 35.0  # dry food slides from about 25 deg on smooth PETG; 35 keeps it moving with crumbs
CHUTE_W = 50.0  # inside; the outlet is 42
CHUTE_WALL = 4.0
CHUTE_FLOOR = 4.0
CHUTE_SIDE = 30.0  # side walls, above the floor
NOSE = 20.0  # spout in front of the body
KIBBLE_DROP = 22.0  # deck underside above the chute floor at its back: the outlet never chokes
CHUTE_BACK = iris.R_AP + 6.0  # inside face of the chute's back wall (y)
BOX_FRONT = -(iris.R_AP + 8.0)  # the side walls reach up to the deck from here back: a box under the outlet

# ───────────────────────────── body ─────────────────────────────
LOBE_END = iris.CENTER_DIST + iris.NEMA_BODY / 2 + 2  # the iris base around the motor
BODY_W, BODY_D = 200.0, 180.0  # the motor lobe reaches 90.7 to the right
BODY_CX = 0.0  # on the iris axis, like the hopper
CORNER_R = 24.0
WALL = 2.4
FLOOR_T = 5.0
DECK_T = 5.0
Y_FRONT = -BODY_D / 2
Y_IN = Y_FRONT + WALL  # inside of the front wall
X_LEFT_IN = BODY_CX - BODY_W / 2 + WALL
X_RIGHT_IN = BODY_CX + BODY_W / 2 - WALL
CORNER_SCREW = 13.0  # floor screws, from each corner along both walls
SCREW_D, PILOT_D = 3.4, 2.5  # M3 clearance, M3 self-tapping into PETG/PLA
M3_HEAD_D = 6.5
MOTOR_CUT = iris.NEMA_BODY + 2.2  # the motor and the S42B pass the deck when the iris goes in
OUTLET_R = iris.R_AP + 2.0
LUG_T, LUG_Y, LUG_H = 6.0, 5.0, 20.0  # under the deck, either side of the chute box
DC_JACK_D = 8.2  # panel jack 5.5/2.1 with an M8 thread (DC-022B and alike)
CABLE_SLOT = (12.0, 7.0)

# ───────────────────────────── electronics ─────────────────────────────
# EMONI main board EHW0014-0011 without buzzer, Eagle coordinates (board x across, y up from the antenna edge)
BOARD_STEP = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..', '(21) Hardware', 'enny-hardware-ehw0014',
                                           'EHW0014-0011', 'EHW0014-0011 w_o Buzzer v3.step'))
BOARD_T = 1.57
BOARD_OUTLINE = [(38.989, 5.334), (43.434, 5.334), (50.608, 12.508), (50.608, 61.38), (-50.608, 61.38), (-50.608, 12.508),
                 (-37.681, -0.42), (-4.249, -0.42), (-1.016, 0), (-1.016, 5.334), (32.258, 5.334), (33.909, 3.683),
                 (37.084, 3.683)]
BOARD_HOLES = [(47.108, 39.28), (-47.108, 39.28)]  # 5 mm: M3 with a washer
LED_RED, LED_GREEN = (-8.382, 45.593), (8.382, 45.593)  # D4, D5 (15-21 package, 0.8 mm high)
BUTTON = (0.0, 35.56)  # S2, 6 x 6, its plunger 4.4 mm above the board
FPC = (0.0, 11.79)  # J2, the camera flex leaves it towards the antenna edge
USB = (-44.93, 46.99)  # J3, its mouth past the board edge at x -51.4
# envelope of the parts, for the assembly STEP and the check when the board's own STEP is not at hand:
# (x0, y0, x1, y1, z0, z1), z from the bottom of the board
BOARD_PARTS = [(-9.2, 9.5, 9.2, 13.8, 1.5, 3.6), (14.0, -0.4, 32.0, 25.1, 1.6, 4.8), (-43.2, -0.4, -27.8, 15.0, -1.5, 3.5),
               (38.0, 14.8, 49.2, 27.8, -1.5, 3.5), (-38.2, 43.5, -30.8, 49.7, 1.6, 4.1), (-51.4, 42.5, -44.5, 51.5, 0.5, 4.7),
               (-5.0, 32.6, 5.0, 38.6, 1.6, 6.0), (-26.1, 47.6, -20.7, 52.8, 1.6, 4.4)]
SMALL_PARTS_H = 2.9  # everything else on the top side stays below this

BOARD_GAP = 8.0  # front wall to the board's top side, which faces the wall
BOARD_X0 = 33.5  # world x of the board's antenna edge (board y = 0): right of the chute
USB_ROOM = 16.0  # deck underside to the board's top edge: an angled USB-C plug
LED_TUBE_OD, LED_HOLE_D = 6.0, 3.0  # light tunnels from the wall to 1 mm above each LED
BUTTON_HOLE_D = 4.0

# camera: a 24-pin OV2640/OV5640 module on its flex, in an eye on the front wall above the spout
CAM_W, CAM_BODY, CAM_LENS_D, CAM_LENS_L = 8.5, 4.5, 8.0, 4.0  # module square, PCB and holder, lens barrel
CAM_FLEX = 75.0  # the common long flex; 21 mm and 40 mm ones do not reach
CAM_HFOV, CAM_VFOV = 54.0, 41.0  # standard 66 deg (diagonal) lens; a 120 deg one sees all of the bowl and the cat
EYE_X = 14.0
EYE_W = 22.0
EYE_DEPTH = 9.0  # lens window centre in front of the wall
EYE_ABOVE_MOUTH = 14.0  # window centre above the top of the chute opening
WINDOW_T = 1.8

# ───────────────────────────── shell and hopper ─────────────────────────────
HOPPER_R = 85.0  # inside
HOPPER_WALL = 2.4
HOPPER_SLOPE = 50.0  # cone: steeper than the 30-35 deg the kibble rests at
SPIGOT_R = 47.0  # inside; outside 49.4 in the 50 mm funnel collar
SPIGOT_WALL = 2.4
SPIGOT_LIFT = 1.5  # the cone starts this far above the collar
SPIGOT_LEN = 12.0
CONE_OFFSET = 3.2  # outer cone, horizontally: 2.45 mm wall
SEAT_R = 80.0  # the shell carries the hopper where its outer cone has this radius
SEAT_T = 4.0
SEAT_CLEAR = 0.3
HOPPER_CYL = 80.0  # straight part
LID_LIP = 12.0
KIBBLE_DENSITY = 0.42  # g/ml, dry cat food 0.40-0.55: the low end
KIBBLE_MASS = 1000.0  # g, required
SHELL_SCREWS = [(BODY_CX - BODY_W / 2 + 6.5, 30.0), (BODY_CX + BODY_W / 2 - 6.5, -40.0), (-30.0, BODY_D / 2 - 6.5),
                (-50.0, -BODY_D / 2 + 6.5)]  # from below through the deck into the shell
CLAMP_GAP = 0.3

# ───────────────────────────── printing ─────────────────────────────
BED = (256.0, 256.0, 256.0)  # Bambu Lab A1

# ═════════════════════════════ layout ═════════════════════════════
TAN = math.tan(math.radians(CHUTE_ANGLE))
Y_EXIT = Y_FRONT - NOSE
Z_EXIT = TRAY_T + BOWL_H + SPOUT_ABOVE_RIM  # top of the chute floor at the spout


def floor_z(y):
    """Top of the chute floor."""
    return Z_EXIT + (y - Y_EXIT) * TAN


CHUTE_FLOOR_V = CHUTE_FLOOR / math.cos(math.radians(CHUTE_ANGLE))  # floor, measured vertically
Y_CHUTE_END = CHUTE_BACK + CHUTE_WALL
Z_DECK = floor_z(CHUTE_BACK) + KIBBLE_DROP  # underside
Z_IRIS = Z_DECK + DECK_T  # the iris base stands here
MOUTH_TOP = floor_z(Y_IN) + CHUTE_SIDE + 1.0  # top of the chute opening, inside the wall

BOWL_Y = Y_FRONT - BOWL_GAP - BOWL_D / 2
BOWL_TARGET = (0.0, BOWL_Y, TRAY_T + 6.0)  # the camera aims at the middle of the bowl's bottom

# board: its x runs down, its y along +x, its top side faces the front wall
BOARD_ORIGIN = (BOARD_X0, Y_IN + BOARD_GAP + BOARD_T, Z_DECK - USB_ROOM - 50.608)


def board_to_world(bx, by, bz=BOARD_T):
    ox, oy, oz = BOARD_ORIGIN
    return (ox + by, oy - bz, oz - bx)


# camera eye: window centre C, axis d aiming at the bowl
EYE_Z = MOUTH_TOP + EYE_ABOVE_MOUTH
CAM_C = (EYE_X, Y_FRONT - EYE_DEPTH, EYE_Z)
CAM_PITCH = round(math.degrees(math.atan2(CAM_C[2] - BOWL_TARGET[2], CAM_C[1] - BOWL_TARGET[1])))
CAM_D = (0.0, -math.cos(math.radians(CAM_PITCH)), -math.sin(math.radians(CAM_PITCH)))

# funnel and hopper heights
Z_FLANGE_TOP = Z_IRIS + iris.Z_TOP + iris.LID_T + 3.0
Z_COLLAR_TOP = Z_IRIS + iris.Z_TOP + iris.LID_T + iris.FUNNEL_H + iris.COLLAR_H
Z_COLLAR_BOTTOM = Z_COLLAR_TOP - iris.COLLAR_H
HOPPER_OUT = HOPPER_R + HOPPER_WALL
SPIGOT_OUT = SPIGOT_R + SPIGOT_WALL
COT = 1 / math.tan(math.radians(HOPPER_SLOPE))
# the hopper rests on its outer cone: where that cone is SEAT_R (plus the clearance) sits the top of the seat
Z_CONE = Z_COLLAR_TOP + SPIGOT_LIFT  # cone start, inside
Z_SEAT = Z_CONE + (SEAT_R - (SPIGOT_R + CONE_OFFSET)) / COT
Z_HOPPER_CYL = Z_CONE + (HOPPER_R - SPIGOT_R) / COT
Z_HOPPER_TOP = Z_HOPPER_CYL + HOPPER_CYL


# ═════════════════════════════ checks ═════════════════════════════
def kibble_volume():
    """ml above the closed iris up to the lid's lip."""
    frustum = lambda h, r0, r1: math.pi * h / 3 * (r0 * r0 + r0 * r1 + r1 * r1)
    sleeve = math.pi * iris.R_AP ** 2 * (iris.Z_TOP + iris.LID_T - iris.SLEEVE_BOTTOM)
    funnel = frustum(iris.FUNNEL_H, iris.R_AP, iris.FUNNEL_TOP_R)
    collar = math.pi * iris.FUNNEL_TOP_R ** 2 * iris.COLLAR_H
    cone = frustum(Z_HOPPER_CYL - Z_CONE, SPIGOT_R, HOPPER_R) + math.pi * SPIGOT_R ** 2 * SPIGOT_LIFT
    cylinder = math.pi * HOPPER_R ** 2 * (HOPPER_CYL - LID_LIP)
    return (sleeve + funnel + collar + cone + cylinder) / 1000


def camera_view():
    """Where the bowl lands in the image: rim points as fractions of the half field (|x|, |y| <= 1 is in view)."""
    d = CAM_D
    right = (1.0, 0.0, 0.0)
    up = (0.0, -d[2], d[1])  # d x right, pointing up
    th, tv = math.tan(math.radians(CAM_HFOV / 2)), math.tan(math.radians(CAM_VFOV / 2))

    def project(p):
        v = [p[i] - CAM_C[i] for i in range(3)]
        depth = sum(v[i] * d[i] for i in range(3))
        return (sum(v[i] * right[i] for i in range(3)) / depth / th, sum(v[i] * up[i] for i in range(3)) / depth / tv)

    rim_z = TRAY_T + BOWL_H
    rim = [project((BOWL_D / 2 * math.cos(a), BOWL_Y + BOWL_D / 2 * math.sin(a), rim_z)) for a in
           [2 * math.pi * k / 72 for k in range(72)]]
    spout = project((0.0, Y_EXIT, floor_z(Y_EXIT) + CHUTE_SIDE))
    dist = math.dist(CAM_C, BOWL_TARGET)
    return rim, spout, dist


def flex_path():
    """Camera to its connector, along the inside of the front wall: mm."""
    back = [CAM_C[i] - CAM_D[i] * (WINDOW_T + CAM_BODY) for i in range(3)]
    fx, fy, fz = board_to_world(*FPC)
    # out of the eye to the wall gap, across to the connector, in (flex bends allowed 10 mm)
    return abs(fx - back[0]) + abs(fz - back[2]) + abs(fy - back[1]) + 10.0


def check(solids=True):
    ok = True

    def report(name, value, good):
        nonlocal ok
        ok &= good
        print(f'{"ok " if good else "BAD"} {name}: {value}')

    print(f'iris base on the deck at z {Z_IRIS:.1f}, funnel collar top {Z_COLLAR_TOP:.1f}, hopper top {Z_HOPPER_TOP:.1f}, '
          f'with the lid {Z_HOPPER_TOP + 2.4:.0f} mm high')
    vol = kibble_volume()
    report('kibble above the iris (ml, g at %.2f g/ml)' % KIBBLE_DENSITY, f'{vol:.0f} ml, {vol * KIBBLE_DENSITY:.0f} g',
           vol * KIBBLE_DENSITY >= KIBBLE_MASS)
    report('spout above the bowl rim (mm)', f'{Z_EXIT - TRAY_T - BOWL_H:.0f}', Z_EXIT - TRAY_T - BOWL_H >= 10)
    report('kibble lands in the bowl: spout tip over the bowl (mm inside the rim)',
           f'{(Y_FRONT - BOWL_GAP) - Y_EXIT:.0f}', Y_EXIT < Y_FRONT - BOWL_GAP)
    report('hopper spigot in the funnel collar (mm), above its bottom (mm)',
           f'{Z_COLLAR_TOP - (Z_CONE - SPIGOT_LEN):.1f}, {Z_CONE - SPIGOT_LEN - Z_COLLAR_BOTTOM:.1f}',
           Z_CONE - SPIGOT_LEN - Z_COLLAR_BOTTOM >= 2 and Z_COLLAR_TOP - (Z_CONE - SPIGOT_LEN) >= 6)
    report('spigot in the collar, radial play (mm)', f'{iris.FUNNEL_TOP_R - SPIGOT_OUT:.1f}', 0.3 <= iris.FUNNEL_TOP_R - SPIGOT_OUT <= 1.0)
    bx0, bz_top = BOARD_X0 - 0.42, board_to_world(-50.608, 0)[2]
    report('board beside the chute (mm)', f'{BOARD_X0 - 0.42 - (CHUTE_W / 2 + CHUTE_WALL):.1f}', bx0 - (CHUTE_W / 2 + CHUTE_WALL) >= 2)
    report('board to the right wall (mm)', f'{X_RIGHT_IN - (BOARD_X0 + 61.38):.1f}', X_RIGHT_IN - (BOARD_X0 + 61.38) >= 2)
    report('board above the floor (mm)', f'{board_to_world(50.608, 0)[2] - FLOOR_T:.0f}', board_to_world(50.608, 0)[2] - FLOOR_T >= 10)
    tallest = max(p[5] for p in BOARD_PARTS) - BOARD_T
    report('top-side parts to the front wall (mm)', f'{BOARD_GAP - tallest:.1f}', BOARD_GAP - tallest >= 1.5)
    path = flex_path()
    report(f'camera flex, path from the eye to J2 (mm, flex {CAM_FLEX:.0f})', f'{path:.0f}', path <= CAM_FLEX)
    rim, spout, dist = camera_view()
    worst = max(max(abs(x), abs(y)) for x, y in rim)
    report(f'camera: pitch {CAM_PITCH} deg, {dist:.0f} mm to the bowl; bowl rim in the image (1 = edge)', f'{worst:.2f}', True)
    print(f'    with a {CAM_HFOV:.0f} x {CAM_VFOV:.0f} deg lens it sees {2 * dist * math.tan(math.radians(CAM_HFOV / 2)):.0f} x '
          f'{2 * dist * math.tan(math.radians(CAM_VFOV / 2)):.0f} mm at the bowl; the spout tip shows at {spout[1]:+.2f} of the half height')
    if not solids:
        return ok

    # the solids: every pair of parts in place, printed and bought, must not overlap
    printed, hardware_parts, _ = assembly()
    IRIS_SET = {n for n, _ in printed if n.startswith('iris')} | {n for n, _ in hardware_parts if n not in ('camera module', 'bowl')}
    board = board_solid(real=True)
    items = printed + hardware_parts + [('EMONI board' + (' (its STEP)' if board[1] else ' (envelope)'), board[0])]
    hits = []
    boxes = [(n, s, s.bounding_box()) for n, s in items]
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            (na, sa, ba), (nb, sb, bb) = boxes[i], boxes[j]
            if not _overlap(ba, bb):
                continue
            if na in IRIS_SET and nb in IRIS_SET:
                continue  # the iris and its screws: checked in iris.py
            v = (sa & sb).volume
            if v > 0.5:
                hits.append(f'{na} / {nb}: {v:.1f} mm3')
    report('parts overlapping', '; '.join(hits) if hits else 'none', not hits)

    sizes = {}
    for name, part in print_poses().items():
        bb = part.bounding_box()
        sizes[name] = (bb.size.X, bb.size.Y, bb.size.Z)
    big = [f'{n} {s[0]:.0f} x {s[1]:.0f} x {s[2]:.0f}' for n, s in sizes.items() if any(a > b for a, b in zip(sorted(s[:2]) + [s[2]], sorted(BED[:2]) + [BED[2]]))]
    report(f'every part on a {BED[0]:.0f} mm bed', ', '.join(big) if big else
           ', '.join(f'{n} {s[0]:.0f}x{s[1]:.0f}x{s[2]:.0f}' for n, s in sizes.items()), not big)
    return ok


def _overlap(a, b):
    return (a.min.X < b.max.X and b.min.X < a.max.X and a.min.Y < b.max.Y and b.min.Y < a.max.Y
            and a.min.Z < b.max.Z and b.min.Z < a.max.Z)


# ═════════════════════════════ solids ═════════════════════════════
def _b3d():
    import build123d
    return build123d


def outline(offset=0.0):
    """The body's footprint, grown by offset."""
    b = _b3d()
    return b.Pos(BODY_CX, 0) * b.RectangleRounded(BODY_W + 2 * offset, BODY_D + 2 * offset, CORNER_R + offset)


def prism(face, z0, z1):
    b = _b3d()
    return b.Pos(0, 0, z0) * b.extrude(face, amount=z1 - z0)


def cyl(r, z0, z1, x=0.0, y=0.0):
    b = _b3d()
    return b.Pos(x, y, z0) * b.Cylinder(r, z1 - z0, align=(b.Align.CENTER, b.Align.CENTER, b.Align.MIN))


def side_prism(pts, x0, x1):
    """A profile in (y, z) extruded along x from x0 to x1."""
    b = _b3d()
    face = b.Plane.YZ * b.Polygon(*pts, align=None)
    return b.Pos(x0, 0) * b.extrude(face, amount=x1 - x0, dir=(1, 0, 0))


def lathe(pts):
    """A solid of revolution about z from an (r, z) profile."""
    b = _b3d()
    face = b.Plane.XZ * b.Polygon(*pts, align=None)
    return b.revolve(face, b.Axis.Z, 360)


def along(origin, direction, solid):
    """solid built along +z, moved to origin with +z along direction (x stays horizontal)."""
    b = _b3d()
    return b.Location(b.Plane(origin=origin, x_dir=(1, 0), z_dir=direction)) * solid


def iris_outline(offset=0.0):
    b = _b3d()
    lobe = b.Polygon(*iris.housing_tangent_polygon(), align=None)
    return b.Circle(iris.R_HOUSING + offset) + (b.offset(lobe, offset) if offset else lobe)


def board_solid(real=False):
    """The EMONI board in place: its own STEP when asked and at hand, else the envelope. (solid, is_real)"""
    b = _b3d()
    loc = b.Location(b.Plane(origin=BOARD_ORIGIN, x_dir=(0, 0, -1), z_dir=(0, -1, 0)))
    if real and os.path.exists(BOARD_STEP):
        return loc * b.import_step(BOARD_STEP), True
    pcb = b.extrude(b.Polygon(*BOARD_OUTLINE, align=None), amount=BOARD_T)
    for x, y in BOARD_HOLES:
        pcb -= b.Pos(x, y, -1) * b.Cylinder(2.5, BOARD_T + 2, align=(b.Align.CENTER, b.Align.CENTER, b.Align.MIN))
    for x0, y0, x1, y1, z0, z1 in BOARD_PARTS:
        pcb += b.Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * b.Box(x1 - x0, y1 - y0, z1 - z0, align=(b.Align.CENTER, b.Align.CENTER, b.Align.MIN))
    return loc * pcb, False


def body():
    b = _b3d()
    up = (b.Align.CENTER, b.Align.CENTER, b.Align.MIN)
    inner = outline(-WALL)
    shell = prism(outline(), FLOOR_T, Z_IRIS) - prism(inner, FLOOR_T - 1, Z_DECK)

    # corners filled from the floor to the deck: the floor screws
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = BODY_CX + sx * (BODY_W / 2 - 9), sy * (BODY_D / 2 - 9)
            block = b.Pos(cx, cy) * b.Rectangle(18, 18)
            shell += prism(block & inner, FLOOR_T, Z_DECK + 0.01)
            sx_, sy_ = BODY_CX + sx * (BODY_W / 2 - CORNER_SCREW), sy * (BODY_D / 2 - CORNER_SCREW)
            shell -= cyl(PILOT_D / 2, FLOOR_T - 1, FLOOR_T + 14, sx_, sy_)

    # deck: the iris outlet, the motor with its driver, the shell screws from below
    shell -= cyl(OUTLET_R, Z_DECK - 1, Z_IRIS + 1)
    shell -= prism(b.Pos(iris.CENTER_DIST, 0) * b.RectangleRounded(MOTOR_CUT, MOTOR_CUT, 4), Z_DECK - 1, Z_IRIS + 1)
    for x, y in SHELL_SCREWS:
        shell -= cyl(SCREW_D / 2, Z_DECK - 1, Z_IRIS + 1, x, y)
        shell -= cyl(M3_HEAD_D / 2, Z_DECK - 1, Z_DECK + 1.5, x, y)

    # lugs that hold the chute box
    xw = CHUTE_W / 2 + CHUTE_WALL + 0.3
    for s in (-1, 1):
        x0 = xw if s > 0 else -xw - LUG_T
        lug = b.Pos(x0 + LUG_T / 2, LUG_Y, Z_DECK - LUG_H) * b.Box(LUG_T, 14, LUG_H + 0.01, align=up)
        shell += lug
        shell -= b.Pos(s * (xw + LUG_T / 2), LUG_Y, Z_DECK - LUG_H / 2) * b.Rot(0, 90) * b.Cylinder(PILOT_D / 2, LUG_T + 2)

    # chute opening in the front wall: the chute's section and a little play
    xm = CHUTE_W / 2 + CHUTE_WALL + 0.5
    ya, yb = Y_FRONT - 3, Y_IN + 3
    mouth = [(ya, floor_z(ya) - CHUTE_FLOOR_V - 0.3), (yb, floor_z(yb) - CHUTE_FLOOR_V - 0.3),
             (yb, floor_z(yb) + CHUTE_SIDE + 1.0), (ya, floor_z(ya) + CHUTE_SIDE + 1.0)]
    shell -= side_prism(mouth, -xm, xm)

    # eye: a wedge on the front wall, its window facing the bowl, the camera in a square pocket behind it
    c, d = CAM_C, CAM_D
    t = (0.0, d[2], -d[1])  # along the window, up and outwards
    a = (c[0], c[1] + 7 * t[1], c[2] + 7 * t[2])  # outer top corner of the window
    s_back = (Y_FRONT - c[1]) / -t[1]
    bot = (c[1] - s_back * t[1], c[2] - s_back * t[2])  # where the window meets the wall
    top_z = a[2] + (Y_FRONT - a[1])  # 45 deg back to the wall: prints upside down without support
    wedge = [(bot[0] + WALL, bot[1]), (bot[0], bot[1]), (a[1], a[2]), (Y_FRONT, top_z), (Y_FRONT + WALL, top_z)]
    shell += side_prism(wedge, EYE_X - EYE_W / 2, EYE_X + EYE_W / 2)
    behind = [c[i] - d[i] * WINDOW_T for i in range(3)]
    shell -= along(behind, (-d[0], -d[1], -d[2]), b.Box(CAM_W + 0.4, CAM_W + 0.4, 40, align=up))
    shell -= along(c, d, b.Pos(0, 0, -5) * b.Cylinder((CAM_LENS_D + 0.4) / 2, 12, align=up))

    # board: two standoffs, light tunnels for the LEDs, a hole to press the button
    y_top = Y_IN + BOARD_GAP  # the board's top side
    for bx, by in BOARD_HOLES:
        x, _, z = board_to_world(bx, by)
        shell += b.Pos(x, Y_IN - 0.01, z) * b.Rot(-90, 0) * b.Cylinder(4.0, BOARD_GAP + 0.01, align=up)
        shell -= b.Pos(x, y_top + 0.01, z) * b.Rot(90, 0) * b.Cylinder(PILOT_D / 2, BOARD_GAP - 1, align=up)
    for bx, by in (LED_RED, LED_GREEN):
        x, _, z = board_to_world(bx, by)
        shell += b.Pos(x, Y_IN - 0.01, z) * b.Rot(-90, 0) * b.Cylinder(LED_TUBE_OD / 2, BOARD_GAP - 1.8, align=up)
        shell -= b.Pos(x, Y_FRONT - 1, z) * b.Rot(-90, 0) * b.Cylinder(LED_HOLE_D / 2, BOARD_GAP + WALL, align=up)
    x, _, z = board_to_world(*BUTTON)
    shell -= b.Pos(x, Y_FRONT - 1, z) * b.Rot(-90, 0) * b.Cylinder(BUTTON_HOLE_D / 2, WALL + 2, align=up)

    # bosses at the foot of the front wall for the tray screws, a cone above (prints hanging from the wall)
    for sx in (-1, 1):
        x, y = BODY_CX + sx * TRAY_SCREW_X, Y_IN + 4.5
        shell += cyl(4.5, FLOOR_T, FLOOR_T + 12, x, y) + b.Pos(x, y, FLOOR_T + 12 - 0.01) * b.Cone(4.5, 1.0, 4.5, align=up)
        shell += b.Pos(x, Y_IN - 0.5, FLOOR_T) * b.Box(9, 5, 12, align=up)
        shell -= cyl(PILOT_D / 2, FLOOR_T - 1, FLOOR_T + 10, x, y)

    # back wall: 12 V jack and a slot for a cable
    yb_ = BODY_D / 2
    shell -= b.Pos(60, yb_ + 1, 40) * b.Rot(90, 0) * b.Cylinder(DC_JACK_D / 2, WALL + 2, align=up)
    shell -= b.Pos(30, yb_ - WALL / 2, 40) * b.Box(CABLE_SLOT[0], WALL + 2, CABLE_SLOT[1])
    return shell


def floor_plate():
    b = _b3d()
    up = (b.Align.CENTER, b.Align.CENTER, b.Align.MIN)
    plate = prism(outline(), 0, FLOOR_T)
    lip = outline(-WALL - 0.3) - outline(-WALL - 2.3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            lip -= b.Pos(BODY_CX + sx * (BODY_W / 2 - 10), sy * (BODY_D / 2 - 10)) * b.Rectangle(22, 22)
    lip -= b.Pos(BODY_CX, Y_FRONT + TONGUE / 2) * b.Rectangle(TONGUE_W + 6, TONGUE + 2)
    plate += prism(lip, FLOOR_T - 0.01, FLOOR_T + 3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = BODY_CX + sx * (BODY_W / 2 - CORNER_SCREW), sy * (BODY_D / 2 - CORNER_SCREW)
            plate -= cyl(SCREW_D / 2, -1, FLOOR_T + 1, x, y)
            plate -= b.Pos(x, y, -0.01) * b.Cone(M3_HEAD_D / 2 + 0.3, SCREW_D / 2, 1.9, align=up)  # countersunk
    # notch for the tray's tongue
    plate -= b.Pos(BODY_CX, Y_FRONT + (TONGUE + 0.3) / 2 - 1, -1) * b.Box(TONGUE_W + 0.6, TONGUE + 2.3, FLOOR_T + 2, align=up)
    return plate


def tray():
    b = _b3d()
    up = (b.Align.CENTER, b.Align.CENTER, b.Align.MIN)
    y_back = Y_FRONT - 0.3
    front = Y_FRONT - TRAY_D
    plate = b.Pos(BODY_CX, (y_back + front) / 2) * b.RectangleRounded(BODY_W, y_back - front, 30)
    plate = prism(plate, 0, TRAY_T)
    plate += b.Pos(BODY_CX, Y_FRONT + TONGUE / 2 - 0.5) * b.Box(TONGUE_W, TONGUE + 1, FLOOR_T, align=up)
    ring = cyl(BOWL_BASE_D / 2 + 1.5 + 2.4, TRAY_T - 0.01, TRAY_T + 3, 0, BOWL_Y) - cyl(BOWL_BASE_D / 2 + 1.5, TRAY_T - 1, TRAY_T + 4, 0, BOWL_Y)
    plate += ring
    for sx in (-1, 1):
        x, y = BODY_CX + sx * TRAY_SCREW_X, Y_IN + 4.5
        plate -= cyl(SCREW_D / 2, -1, FLOOR_T + 1, x, y)
        plate -= b.Pos(x, y, -0.01) * b.Cone(M3_HEAD_D / 2 + 0.3, SCREW_D / 2, 1.9, align=up)
    return plate


def chute():
    b = _b3d()
    xi, xo = CHUTE_W / 2, CHUTE_W / 2 + CHUTE_WALL
    ye = Y_CHUTE_END
    floor_pts = [(Y_EXIT, floor_z(Y_EXIT)), (ye, floor_z(ye)), (ye, floor_z(ye) - CHUTE_FLOOR_V), (Y_EXIT, floor_z(Y_EXIT) - CHUTE_FLOOR_V)]
    part = side_prism(floor_pts, -xo, xo)
    top = Z_DECK - 0.5
    ramp = BOX_FRONT - 25
    wall_pts = [(Y_EXIT, floor_z(Y_EXIT) - 0.01), (ye, floor_z(ye) - 0.01), (ye, top), (BOX_FRONT, top),
                (ramp, floor_z(ramp) + CHUTE_SIDE), (Y_EXIT, floor_z(Y_EXIT) + CHUTE_SIDE)]
    for s in (-1, 1):
        part += side_prism(wall_pts, xi if s > 0 else -xo, xo if s > 0 else -xi)
    back = [(CHUTE_BACK, floor_z(CHUTE_BACK) - 0.01), (ye, floor_z(ye) - 0.01), (ye, top), (CHUTE_BACK, top)]
    part += side_prism(back, -xo, xo)
    # screws from inside the box out into the lugs
    part -= b.Pos(0, LUG_Y, Z_DECK - LUG_H / 2) * b.Rot(0, 90) * b.Cylinder(SCREW_D / 2, 2 * xo + 2)
    return part


def iris_keepout():
    """Where the iris, its funnel and the lid screws are, with play: the shell keeps out of it."""
    face = iris_outline(0.3)
    k = prism(face, Z_IRIS - 1, Z_IRIS + iris.Z_TOP + iris.LID_T + CLAMP_GAP)
    k += cyl(iris.LID_SCREW_R + 4.5 + 0.3, Z_IRIS, Z_FLANGE_TOP + CLAMP_GAP)
    k += cyl(iris.FUNNEL_TOP_R + iris.WALL + 0.5, Z_IRIS, Z_COLLAR_TOP + 0.5)
    for a in iris.LID_SCREW_ANGLES:
        x, y = iris.polar(iris.LID_SCREW_R, a)
        k += cyl(3.5, Z_IRIS, Z_FLANGE_TOP + 4, x, y)
    k += cyl(iris.SHAFT_CLEAR_D / 2 + 1, Z_IRIS, Z_IRIS + iris.MOTOR_SHAFT_L + 1, iris.CENTER_DIST, 0)
    return k


def shell():
    b = _b3d()
    up = (b.Align.CENTER, b.Align.CENTER, b.Align.MIN)
    part = prism(outline(), Z_IRIS, Z_SEAT) - prism(outline(-WALL), Z_IRIS - 1, Z_SEAT - SEAT_T)
    # cone seat for the hopper
    r_top = SEAT_R + SEAT_CLEAR
    r_bot = r_top - SEAT_T / math.tan(math.radians(HOPPER_SLOPE))
    part -= b.Pos(0, 0, Z_SEAT - SEAT_T - 0.01) * b.Cone(r_bot, r_top, SEAT_T + 0.02, align=up)

    def beam(p_tip, p_wall, z_bottom, width, height, slope=True):
        """A rib from p_tip to the wall and into it, standing on z_bottom."""
        L = math.dist(p_tip, p_wall)
        ang = math.degrees(math.atan2(p_wall[1] - p_tip[1], p_wall[0] - p_tip[0]))
        top = height + (L + WALL if slope else 0)  # 45 deg towards the wall: prints hanging from it
        prof = b.Plane.XZ * b.Polygon((0, 0), (L + WALL, 0), (L + WALL, top), (0, height), align=None)
        solid = b.extrude(prof, amount=width / 2, both=True)
        return b.Pos(p_tip[0], p_tip[1], z_bottom) * b.Rot(0, 0, ang) * solid

    xl, xr, yb, yf = X_LEFT_IN, X_RIGHT_IN, BODY_D / 2 - WALL, Y_IN
    ribs = []
    # ribs that locate the iris base, from the shell floor up
    r = iris.R_HOUSING + 0.3
    h = iris.Z_TOP - 1.5
    ribs += [beam((0, r), (0, yb), Z_IRIS, 4, h), beam((0, -r), (0, yf), Z_IRIS, 4, h),
             beam((-r, 0), (xl, 0), Z_IRIS, 4, h)]
    for y in (-16, 16):
        ribs.append(beam((LOBE_END + 0.3, y), (xr, y), Z_IRIS, 4, h))
    rib_solid = ribs[0]
    for rb in ribs[1:]:
        rib_solid += rb
    part += rib_solid - iris_keepout()
    # clamps: two on the funnel flange, one on the lid over the motor
    z_flange = Z_FLANGE_TOP + CLAMP_GAP
    z_lid = Z_IRIS + iris.Z_TOP + iris.LID_T + CLAMP_GAP
    clamps = [beam((-31, 52), (-31, yb), z_flange, 10, 4, False), beam((-31, -52), (-31, yf), z_flange, 10, 4, False),
              beam((84, 0), (xr, 0), z_lid, 12, 4, False)]
    for cl in clamps:
        # a 45 deg gusset on top, so the clamp prints hanging from the wall
        part += cl
    for p_tip, p_wall, z0, w in (((-31, 52), (-31, yb), z_flange, 10), ((-31, -52), (-31, yf), z_flange, 10), ((84, 0), (xr, 0), z_lid, 12)):
        L = math.dist(p_tip, p_wall)
        ang = math.degrees(math.atan2(p_wall[1] - p_tip[1], p_wall[0] - p_tip[0]))
        prof = b.Plane.XZ * b.Polygon((0, 4), (L + 0.5, 4), (L + 0.5, 4 + L), align=None)
        part += b.Pos(p_tip[0], p_tip[1], z0) * b.Rot(0, 0, ang) * b.extrude(prof, amount=w / 2, both=True)
    part = part & prism(outline(), Z_IRIS, Z_SEAT)
    # screw bosses at the bottom
    for x, y in SHELL_SCREWS:
        part += cyl(4.5, Z_IRIS, Z_IRIS + 18, x, y) + b.Pos(x, y, Z_IRIS + 18 - 0.01) * b.Cone(4.5, 1.0, 4.5, align=up)
        part -= cyl(PILOT_D / 2, Z_IRIS - 1, Z_IRIS + 14, x, y)
    return part & prism(outline(), Z_IRIS, Z_SEAT)


def hopper():
    zsb = Z_CONE - SPIGOT_LEN
    z_out = Z_CONE + (HOPPER_OUT - (SPIGOT_R + CONE_OFFSET)) / COT
    pts = [(SPIGOT_R, zsb), (SPIGOT_OUT, zsb), (SPIGOT_OUT, Z_CONE), (SPIGOT_R + CONE_OFFSET, Z_CONE), (HOPPER_OUT, z_out),
           (HOPPER_OUT, Z_HOPPER_TOP), (HOPPER_R, Z_HOPPER_TOP), (HOPPER_R, Z_HOPPER_CYL), (SPIGOT_R, Z_CONE)]
    return lathe(pts)


def hopper_lid():
    b = _b3d()
    z = Z_HOPPER_TOP
    lid = cyl(HOPPER_OUT + 2.5, z, z + 2.4)  # the rim stands 2.5 mm over the hopper: lift it there
    lid += cyl(HOPPER_R - 0.4, z - LID_LIP, z + 0.01) - cyl(HOPPER_R - 2.8, z - LID_LIP - 1, z + 0.02)
    return lid


def camera_module():
    b = _b3d()
    up = (b.Align.CENTER, b.Align.CENTER, b.Align.MIN)
    d = CAM_D
    behind = [CAM_C[i] - d[i] * (WINDOW_T + CAM_BODY) for i in range(3)]
    m = b.Box(CAM_W, CAM_W, CAM_BODY, align=up) + b.Pos(0, 0, CAM_BODY - 0.01) * b.Cylinder(CAM_LENS_D / 2, CAM_LENS_L, align=up)
    return along(behind, d, m)


def bowl():
    rim_z = TRAY_T + BOWL_H
    pts = [(0, TRAY_T), (BOWL_BASE_D / 2, TRAY_T), (BOWL_D / 2, rim_z), (BOWL_D / 2 - 1.2, rim_z), (BOWL_BASE_D / 2 - 1.2, TRAY_T + 1.2), (0, TRAY_T + 1.2)]
    return _b3d().Pos(0, BOWL_Y, 0) * lathe(pts)


def parts():
    return {'body': body(), 'floor': floor_plate(), 'chute': chute(), 'shell': shell(), 'hopper': hopper(),
            'hopper_lid': hopper_lid(), 'tray': tray()}


_CACHE = {}


def assembly():
    """(printed, bought, iris printed) as (name, solid) in place."""
    if 'a' in _CACHE:
        return _CACHE['a']
    b = _b3d()
    p = parts()
    printed = [(n, s) for n, s in p.items()]
    at = b.Pos(0, 0, Z_IRIS)
    _, iris_assembly = iris.build_parts()
    iris_parts = [(f'iris {n}', at * s) for n, s in iris_assembly(0)]
    turn = b.Pos(iris.CENTER_DIST, 0) * b.Rot(0, 0, 90) * b.Pos(-iris.CENTER_DIST, 0)  # the S42B's header to the front
    bought = []
    for n, s in iris.hardware(0):
        bought.append((n, at * (turn * s if n.startswith(('driver', 'motor 17')) else s)))
    bought += [('camera module', camera_module()), ('bowl', bowl())]
    _CACHE['a'] = (printed + iris_parts, bought, p)
    return _CACHE['a']


def print_poses():
    """Every printed part lying on the bed as it prints."""
    b = _b3d()
    p = assembly()[2]

    def on_bed(s):
        return b.Pos(0, 0, -s.bounding_box().min.Z) * s

    return {
        'body': on_bed(b.Rot(180, 0) * p['body']),  # deck on the bed
        'floor': on_bed(p['floor']),
        'chute': on_bed(b.Rot(-CHUTE_ANGLE, 0) * p['chute']),  # floor on the bed: the kibble slides on the smooth side
        'shell': on_bed(b.Rot(180, 0) * p['shell']),  # hopper seat on the bed
        'hopper': on_bed(p['hopper']),
        'hopper_lid': on_bed(b.Rot(180, 0) * p['hopper_lid']),
        'tray': on_bed(p['tray']),
    }


COLORS = {
    'body': '#8b5a3c', 'floor': '#5c3a26', 'chute': '#e0a526', 'shell': '#c9b18f', 'hopper': '#d9e4ec',
    'hopper_lid': '#d9622b', 'tray': '#7f9a2e', 'camera': '#202020', 'bowl': '#b8bcc2', 'EMONI': '#1f6b3a',
}


def color_of(name):
    key = name.split()[0]
    if key == 'iris':
        return iris.color_of(name.split(' ', 1)[1])
    return COLORS.get(key, iris.color_of(name))


def build():
    from build123d import Color, Compound, export_step, export_stl

    for sub in ('step', 'stl'):
        os.makedirs(os.path.join(HERE, sub), exist_ok=True)
    printed, bought, p = assembly()
    for name, part in print_poses().items():
        export_stl(part, os.path.join(HERE, 'stl', f'{name}.stl'), tolerance=0.02, angular_tolerance=0.15)
        export_step(p[name], os.path.join(HERE, 'step', f'{name}.step'))
        print(f'{name}: {part.volume / 1000:.0f} cm3')
    children = []
    for name, solid in printed + bought + [('EMONI board EHW0014-0011 (envelope)', board_solid()[0])]:
        solid = copy.deepcopy(solid)
        solid.label, solid.color = name, Color(color_of(name))
        children.append(solid)
    export_step(Compound(label='kibbl. feeder', children=children), os.path.join(HERE, 'step', 'assembly.step'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='check only, export nothing')
    parser.add_argument('--quick', action='store_true', help='the numbers only, not the solids')
    args = parser.parse_args()
    if not check(solids=not args.quick):
        raise SystemExit('the check failed, nothing exported')
    if not args.check and not args.quick:
        build()
