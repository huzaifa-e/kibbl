"""
Case of the kibbl. cam: the AI-Thinker ESP32-CAM on its USB-C programmer board
(ESP32-CAM-MB, same 40 x 27 mm footprint), powered over USB-C.

    python case.py                  STEP and STL of every part into step/ and stl/
    python case.py --check BOARD    checks the case against the ESP32-CAM STEP model
                                    (ESP3-CAM_v4.step, CC-BY, thingiverse)

Parts, printed on a Bambu Lab A1 without supports:
    case_front      front shell: lens opening, flash window with light tunnel, USB-C
                    slot, status-led window, button and vent slots, clip-on grooves
    case_back       back cover: kibbl. engraved, keyhole hanger, two M2 screws
    case_label      the letters alone, for a second colour with the AMS lite
    clip_shelf      clip-on: hangs the camera from a shelf or monitor edge
    clip_strap      clip-on: velcro strap or zip tie around cage bars, poles, legs
    clip_tripod     clip-on: 1/4"-20 nut for a mini tripod or ball head

Frame: x along the boards, 0 at the top end (lens, sd slot), the USB-C port at
the bottom end; y across them; z from the front face (0) to the back. The board
positions come from the ESP32-CAM model: lens, flash led and status led are where
--check finds them.
"""
import argparse
import math
import os

# ─────────────────────────── the boards ───────────────────────────
BOARD_L, BOARD_W = 40.0, 27.0  # ESP32-CAM and ESP32-CAM-MB, flush at both ends
LENS = (11.4, 13.5)  # lens centre (x, y), on the camera module over the sd slot
FLASH = (32.2, 3.7)  # white 5050 flash led, next to the camera connector
STATUS_LED = (12.0, 18.0)  # red led, on the back of the camera board
CAMERA_ABOVE_BOARD = 8.07  # camera module top above the camera board's front
FLASH_ABOVE_BOARD = 1.92
BOARD_T, MB_T = 1.0, 1.6
HEADER_STACK = 11.0  # camera board back to MB front: female 8.5 + male spacer 2.5
MB_PINS = 1.6  # solder joints under the MB

# ─────────────────────────── the case ───────────────────────────
WALL = 1.8
FRONT_T = 1.6
CAMERA_GAP = 0.4  # camera module top to the inside of the front
CLEAR = 0.4  # board edges to the walls; 0.8 at the top end, where an sd card sticks out
TOP_BLOCK = 5.8  # solid top end: the two cover screws
CORNER_R = 4.0
COVER_T = 2.4

Z_CAMERA_TOP = FRONT_T + CAMERA_GAP
Z_BOARD_FRONT = Z_CAMERA_TOP + CAMERA_ABOVE_BOARD
Z_BOARD_BACK = Z_BOARD_FRONT + BOARD_T
Z_MB_FRONT = Z_BOARD_BACK + HEADER_STACK
Z_MB_BACK = Z_MB_FRONT + MB_T
Z_RIM = Z_MB_BACK + MB_PINS  # back rim of the shell, inside face of the cover
Z_BACK = Z_RIM + COVER_T  # the back face, against the wall when hung

CAV_X0, CAV_X1 = -0.8, BOARD_L + CLEAR
CAV_Y0, CAV_Y1 = -CLEAR, BOARD_W + CLEAR
OUT_X0, OUT_X1 = CAV_X0 - TOP_BLOCK, CAV_X1 + WALL
OUT_Y0, OUT_Y1 = CAV_Y0 - WALL, CAV_Y1 + WALL

# openings
LENS_INNER_D, LENS_OUTER_D = 5.6, 8.8  # the OV2640 sees about 66 deg: a cone
LENS_RING_D, LENS_RING_W, LENS_RING_DEPTH = 14.0, 0.6, 0.4  # a fine ring groove around it, the "eye"
FLASH_WIN, FLASH_WIN_OUTER = 6.2, 8.2
TUNNEL_WALL = 0.8
TUNNEL_GAP = 1.0
USB_W, USB_W_OUTER = 9.8, 13.4  # receptacle; the plug's overmould in the outer recess
USB_Z0, USB_Z0_OUTER = 17.5, 16.0
USB_WALL_LEFT = 0.6  # wall left at the port, so the plug reaches all the way in

# cover
SCREW_PILOT_D, SCREW_HOLE_D, SCREW_HEAD_D = 1.7, 2.4, 4.4  # M2 self-tapping, countersunk
SCREW_DEPTH = 10.0
SCREWS = [(CAV_X0 - TOP_BLOCK / 2, 6.5), (CAV_X0 - TOP_BLOCK / 2, BOARD_W - 6.5)]
LIP_W, LIP_FIT = 1.0, 0.15
TAB_L, TAB_W = 14.0, 18.0
KEY_HEAD_D, KEY_SLOT_W, KEY_SLOT_L = 7.5, 3.6, 4.5  # nail or screw head through, shank holds
LABEL = 'kibbl.'
LABEL_SIZE, LABEL_DEPTH = 8.5, 0.6
LABEL_FONT = '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf'

# clip-on interface: a V groove along both long walls, every add-on grips it
GROOVE_Z, GROOVE_DEPTH, GROOVE_W = Z_RIM - 2.7, 0.8, 1.6
CRADLE_T, CRADLE_FIT = 1.8, 0.15
RIDGE = CRADLE_FIT + 0.6  # 0.6 into the 0.8 groove, 45 deg flanks like the groove: 0.2 play
CRADLE_L = 24.0

# add-ons
SHELF = 20.0  # shelf or monitor thickness the clip hooks over
NUT_AF, NUT_T, TRIPOD_D = 11.3, 5.7, 6.7  # 1/4"-20 hex nut and screw


def build_parts():
    from build123d import Align, Box, Circle, Cone, Cylinder, FontStyle, Plane, Polygon, Pos, Rectangle, RectangleRounded, Rot, SlotCenterToCenter, Text, extrude

    up = (Align.CENTER, Align.CENTER, Align.MIN)

    def rrect(x0, x1, y0, y1, r):
        return Pos((x0 + x1) / 2, (y0 + y1) / 2) * RectangleRounded(x1 - x0, y1 - y0, r)

    def prism(face, z0, z1):
        return Pos(0, 0, z0) * extrude(face, amount=z1 - z0, dir=(0, 0, 1))

    def box(x0, x1, y0, y1, z0, z1):
        return Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * Box(x1 - x0, y1 - y0, z1 - z0, align=up)

    def cyl(r, z0, z1, x, y):
        return Pos(x, y, z0) * Cylinder(r, z1 - z0, align=up)

    def cone(r0, r1, z0, z1, x, y):
        return Pos(x, y, z0) * Cone(r0, r1, z1 - z0, align=up)

    def _x_sweep(face, x0, x1):
        """A face drawn in the XY plane as (y, z), swept along x from x0 to x1."""
        # along +z whatever way the outline winds: (u, v, w) with (u, v) = (y, z)
        solid = extrude(face, amount=x1 - x0, dir=(0, 0, 1))
        # a plane whose x is the world's y and whose normal is the world's x: (u, v, w) -> (x = w, y = u, z = v)
        return Plane(origin=(x0, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0)) * solid

    outline = rrect(OUT_X0, OUT_X1, OUT_Y0, OUT_Y1, CORNER_R)
    cavity = rrect(CAV_X0, CAV_X1, CAV_Y0, CAV_Y1, 1.0)

    # ═══════════ front shell ═══════════
    front = prism(outline, 0, Z_RIM) - prism(cavity, FRONT_T, Z_RIM + 1)

    # lens: a fine ring groove outside (a recess would hang over the bed), a cone through the front
    front -= cyl(LENS_RING_D / 2, -1, LENS_RING_DEPTH, *LENS) - cyl(LENS_RING_D / 2 - LENS_RING_W, -2, LENS_RING_DEPTH + 1, *LENS)
    front -= cone(LENS_OUTER_D / 2, LENS_INNER_D / 2, -0.01, FRONT_T + 0.01, *LENS)

    # flash: a chamfered window and a tunnel towards the led, so its light leaves through
    # the front and does not shine around the inside into the lens. It stops 1 mm short
    # of the led: the camera's ribbon cable passes right behind its far wall.
    tunnel_end = Z_BOARD_FRONT - FLASH_ABOVE_BOARD - TUNNEL_GAP
    fx, fy = FLASH
    o = FLASH_WIN / 2 + TUNNEL_WALL
    front += box(fx - o, fx + o, max(fy - o, CAV_Y0), fy + o, FRONT_T - 0.01, tunnel_end)
    win = Pos(fx, fy) * Rectangle(FLASH_WIN, FLASH_WIN)
    front -= prism(win, FRONT_T - 0.5, tunnel_end + 0.01)
    front -= Pos(fx, fy, -0.01) * extrude(Rectangle(FLASH_WIN_OUTER, FLASH_WIN_OUTER), amount=FRONT_T - 0.49,
                                          taper=math.degrees(math.atan((FLASH_WIN_OUTER - FLASH_WIN) / 2 / (FRONT_T - 0.5))))

    # side walls: the red status led glows between the boards; tool slots for the IO0
    # and RST buttons of the MB, which are vents as well
    sx, sy = STATUS_LED
    front -= box(sx - 5, sx + 5, CAV_Y1 - 0.1, OUT_Y1 + 1, Z_BOARD_BACK + 1.0, Z_BOARD_BACK + 4.0)
    for y0, y1 in ((OUT_Y0 - 1, CAV_Y0 + 0.1), (CAV_Y1 - 0.1, OUT_Y1 + 1)):
        front -= box(26.0, 38.0, y0, y1, Z_BOARD_BACK + 2.0, Z_MB_FRONT - 2.0)

    # USB-C: slot open towards the back (the boards go in from behind), outer recess for the plug
    usb_y = BOARD_W / 2
    front -= box(CAV_X1 - 0.1, OUT_X1 + 1, usb_y - USB_W / 2, usb_y + USB_W / 2, USB_Z0, Z_RIM + 1)
    front -= box(CAV_X1 + USB_WALL_LEFT, OUT_X1 + 1, usb_y - USB_W_OUTER / 2, usb_y + USB_W_OUTER / 2, USB_Z0_OUTER, Z_RIM + 1)

    # cover screws in the top block
    for x, y in SCREWS:
        front -= cyl(SCREW_PILOT_D / 2, Z_RIM - SCREW_DEPTH, Z_RIM + 1, x, y)

    # clip-on grooves: V along both long walls, closed at the top, open at the USB end
    gz, gd, gw = GROOVE_Z, GROOVE_DEPTH, GROOVE_W / 2
    for y_wall, inward in ((OUT_Y0, 1), (OUT_Y1, -1)):
        tri = [(y_wall - inward * 0.5, gz - gw - 0.5), (y_wall + inward * gd, gz), (y_wall - inward * 0.5, gz + gw + 0.5)]
        front -= _x_sweep(Polygon(*tri, align=None), CAV_X0 + 2.0, OUT_X1 + 1)

    # ═══════════ back cover ═══════════
    # hanging tab: a round end beyond the top of the case
    tab_c = OUT_X0 - TAB_L + TAB_W / 2
    tab = Pos(tab_c, BOARD_W / 2) * Circle(TAB_W / 2) + Pos((tab_c + OUT_X0 + 2) / 2, BOARD_W / 2) * Rectangle(OUT_X0 + 2 - tab_c, TAB_W)
    back = prism(outline + tab, Z_RIM, Z_BACK)

    # keyhole: the head passes the round hole, the camera drops, the slot holds the shank
    key_x = OUT_X0 - KEY_HEAD_D / 2 - 1.0  # the head hole next to the case, the slot towards the tip
    back -= cyl(KEY_HEAD_D / 2, Z_RIM - 1, Z_BACK + 1, key_x, BOARD_W / 2)
    back -= prism(Pos(key_x - KEY_SLOT_L / 2, BOARD_W / 2) * SlotCenterToCenter(KEY_SLOT_L, KEY_SLOT_W), Z_RIM - 1, Z_BACK + 1)

    # lip into the shell, behind the MB
    lip_outer = rrect(CAV_X0 + LIP_FIT, CAV_X1 - LIP_FIT, CAV_Y0 + LIP_FIT, CAV_Y1 - LIP_FIT, 0.9)
    lip_inner = rrect(CAV_X0 + LIP_FIT + LIP_W, CAV_X1 - LIP_FIT - LIP_W, CAV_Y0 + LIP_FIT + LIP_W, CAV_Y1 - LIP_FIT - LIP_W, 0.5)
    back += prism(lip_outer - lip_inner, Z_MB_BACK + 0.2, Z_RIM + 0.01)
    # rails that press the MB forward, clear of the header pins in the middle
    for x0, x1 in ((1.0, 3.0), (BOARD_L - 3.0, BOARD_L - 1.0)):
        for y0, y1 in ((3.0, 9.0), (BOARD_W - 9.0, BOARD_W - 3.0)):
            back += box(x0, x1, y0, y1, Z_MB_BACK + 0.1, Z_RIM + 0.01)

    for x, y in SCREWS:
        back -= cyl(SCREW_HOLE_D / 2, Z_RIM - 1, Z_BACK + 1, x, y)
        back -= cone(SCREW_HOLE_D / 2, SCREW_HEAD_D / 2 + 0.2, Z_BACK - 1.2, Z_BACK + 0.01, x, y)

    # the name, read from behind with the camera hanging (USB-C down): along +y, top towards -x
    text = Text(LABEL, LABEL_SIZE, font_path=LABEL_FONT, font_style=FontStyle.BOLD)
    label_x = (CAV_X0 + OUT_X1) / 2 + 2.0
    label = Pos(label_x, BOARD_W / 2, Z_BACK - LABEL_DEPTH) * Rot(0, 0, 90) * extrude(text, amount=LABEL_DEPTH + 0.01, dir=(0, 0, 1))
    back -= label

    # ═══════════ clip-on cradle and add-ons ═══════════
    zb = Z_BACK + CRADLE_FIT  # inside of the cradle's back plate
    zp = zb + CRADLE_T  # outside of the back plate
    yl, yr = OUT_Y0 - CRADLE_FIT, OUT_Y1 + CRADLE_FIT  # inside faces of the arms
    tip = GROOVE_Z - GROOVE_W / 2 - 0.9

    def cradle_profile():
        # U around the back and both sides, with a ridge into each groove and lead-in chamfers
        return [
            (yl - CRADLE_T, zp), (yr + CRADLE_T, zp), (yr + CRADLE_T, tip), (yr + 0.3, tip),
            (yr, tip + 0.3), (yr, GROOVE_Z - RIDGE), (yr - RIDGE, GROOVE_Z), (yr, GROOVE_Z + RIDGE), (yr, zb), (yl, zb),
            (yl, GROOVE_Z + RIDGE), (yl + RIDGE, GROOVE_Z), (yl, GROOVE_Z - RIDGE), (yl, tip + 0.3), (yl - 0.3, tip),
            (yl - CRADLE_T, tip),
        ]

    def cradle(x0):
        return _x_sweep(Polygon(*cradle_profile(), align=None), x0, x0 + CRADLE_L)

    y_c = BOARD_W / 2
    cy0, cy1 = yl - CRADLE_T, yr + CRADLE_T

    # shelf clip: the cradle at the top of the case, a hook over the shelf behind it. The bar
    # is level with the cradle's top, so the part prints standing on bar and cradle; the
    # camera's top end may stand a little above the shelf, in front of its edge.
    sx0 = 2.0
    shelf = cradle(sx0)
    top = sx0
    shelf += box(top, top + 2.4, cy0, cy1, zb, zp + SHELF + 2.4)  # top bar over the shelf
    shelf += box(top, sx0 + CRADLE_L, cy0, cy1, zp + SHELF, zp + SHELF + 2.4)  # leg behind the shelf
    shelf += box(sx0 + CRADLE_L - 6, sx0 + CRADLE_L, cy0, cy1, zp + SHELF - 1.2, zp + SHELF + 0.01)  # grip lip

    # strap mount: a loop behind the cradle for a 20 mm velcro strap or zip ties
    tx0 = 8.0
    strap = cradle(tx0)
    gap = 3.5
    strap += box(tx0, tx0 + CRADLE_L, y_c - 13, y_c + 13, zp + gap, zp + gap + 2.4)  # bar
    for a, b in ((tx0, tx0 + 1.5), (tx0 + CRADLE_L - 1.5, tx0 + CRADLE_L)):
        strap += box(a, b, y_c - 13, y_c + 13, zp - 0.01, zp + gap + 0.01)

    # tripod mount: a block with a captive 1/4"-20 nut, screw from behind
    px0 = 8.0
    tripod = cradle(px0)
    block_d = NUT_T + 4.0
    tripod += box(px0, px0 + CRADLE_L, y_c - 10, y_c + 10, zp - 0.01, zp + block_d)
    tcx = px0 + CRADLE_L / 2
    tripod -= cyl(TRIPOD_D / 2, zp + 1.0, zp + block_d + 1, tcx, y_c)
    # the nut slides in from the side and is held against the pull of the screw
    # flats towards +-x: printed standing (x up), the pocket's top is a 6.5 mm bridge between 60 deg faces
    hexagon = [(NUT_AF / math.sqrt(3) * math.cos(math.radians(a)), NUT_AF / math.sqrt(3) * math.sin(math.radians(a))) for a in range(30, 390, 60)]
    nut_z0 = zp + 1.5
    nut = Pos(tcx, y_c, nut_z0) * extrude(Polygon(*hexagon, align=None), amount=NUT_T, dir=(0, 0, 1))
    tripod -= nut
    tripod -= box(tcx - NUT_AF / 2, tcx + NUT_AF / 2, y_c, y_c + 12, nut_z0, nut_z0 + NUT_T)

    parts = {
        'case_front': front,
        'case_back': back,
        'case_label': Pos(label_x, BOARD_W / 2, Z_BACK - LABEL_DEPTH) * Rot(0, 0, 90) * extrude(text, amount=LABEL_DEPTH, dir=(0, 0, 1)),
        'clip_shelf': shelf,
        'clip_strap': strap,
        'clip_tripod': tripod,
    }
    return parts


def print_pose(name, part):
    """Every part flat on the bed, in the orientation that needs no support."""
    from build123d import Pos, Rot

    if name == 'case_front':
        return part  # front face on the bed: the face people see is the smooth one
    if name in ('case_back', 'case_label'):
        return Pos(0, 0, Z_BACK) * Rot(180, 0, 0) * part  # back face on the bed, lip and rails up
    # clip-ons: their profile on the bed, the hook bar and loops bridge at the top
    turned = Rot(0, -90, 0) * part  # +x becomes +z
    bb = turned.bounding_box()
    return Pos(-bb.min.X, -bb.min.Y, -bb.min.Z) * turned


def board_solids(step_path):
    """The ESP32-CAM model placed in the case: front up as z decreases."""
    from build123d import Pos, Rot, import_step

    model = import_step(step_path)
    # model: board in X-Z, front towards +Y, front surface at Y = 1
    return Pos(0, 0, Z_BOARD_BACK) * Rot(-90, 0, 0) * model


def check(step_path):
    from build123d import Align, Box, Pos

    parts = build_parts()
    board = board_solids(step_path)
    ok = True
    bb = board.bounding_box()
    print(f'    camera board placed at x {bb.min.X:.1f}..{bb.max.X:.1f}, y {bb.min.Y:.1f}..{bb.max.Y:.1f}, z {bb.min.Z:.1f}..{bb.max.Z:.1f}')
    # solid by solid: the placement of the whole model reaches its solids, not its named groups
    solids = board.solids()
    for name in ('case_front', 'case_back'):
        clash = sum((parts[name] & s).volume for s in solids)
        print(f'{"ok " if clash < 0.01 else "BAD"} {name} against the camera board: {clash:.3f} mm3')
        ok &= clash < 0.01
    mb = Pos(BOARD_L / 2, BOARD_W / 2, Z_MB_FRONT) * Box(BOARD_L, BOARD_W, MB_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for name in ('case_front', 'case_back'):
        clash = (parts[name] & mb).volume
        print(f'{"ok " if clash < 0.01 else "BAD"} {name} against the MB board: {clash:.3f} mm3')
        ok &= clash < 0.01

    # the lens and the flash led of the model, seen through their openings

    def find(size, tol=0.15):
        hits = []
        for s in solids:
            bb = s.bounding_box()
            dims = sorted([bb.size.X, bb.size.Y, bb.size.Z])
            if all(abs(a - b) < tol for a, b in zip(dims, sorted(size))):
                hits.append(bb)
        return hits

    lens = [bb for bb in find((2.0, 2.0, 1.43))]
    flash = [bb for bb in find((5.4, 5.0, 1.62), 0.3)]
    for label, hits, want in (('lens', lens, LENS), ('flash led', flash, FLASH)):
        if not hits:
            print(f'?   {label}: not found in the model')
            continue
        bb = hits[0]
        c = ((bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2)
        off = math.hypot(c[0] - want[0], c[1] - want[1])
        good = off < 0.6
        ok &= good
        print(f'{"ok " if good else "BAD"} {label} at ({c[0]:.2f}, {c[1]:.2f}), opening at {want}: {off:.2f} mm apart, front at z {bb.min.Z:.2f}')
    return ok


def export():
    from build123d import Compound, export_step, export_stl

    here = os.path.dirname(os.path.abspath(__file__))
    for sub in ('step', 'stl'):
        os.makedirs(os.path.join(here, sub), exist_ok=True)
    parts = build_parts()
    for name, part in parts.items():
        export_stl(print_pose(name, part), os.path.join(here, 'stl', f'{name}.stl'), tolerance=0.01, angular_tolerance=0.1)
        export_step(part, os.path.join(here, 'step', f'{name}.step'))
        bb = part.bounding_box()
        print(f'{name}: {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f} mm, {part.volume / 1000:.1f} cm3')
    export_step(Compound([parts['case_front'], parts['case_back']]), os.path.join(here, 'step', 'case_assembly.step'))
    return parts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', metavar='BOARD_STEP', help='check the case against the ESP32-CAM STEP model')
    args = parser.parse_args()
    if args.check:
        raise SystemExit(0 if check(args.check) else 1)
    export()
