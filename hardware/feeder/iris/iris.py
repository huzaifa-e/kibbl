"""
Mechanical iris for the cat feeder, driven by a NEMA 17 stepper.

Kibble falls from the hopper onto six blades; the stepper turns a ring gear that
swings the blades open (42 mm) or closed. How far and how long it opens decides
the portion.

    python iris.py            STEP and STL of every part, and the assembly, into step/ and stl/
    python iris.py --check    kinematics only: closure, blade layers, pin clearance, drive

Parts (all printed flat, without supports):
    base      floor with the pivot pins, blade cavity, ring ledge, motor mount
    blade     6x, 1.2 mm, drive pin on top
    ring      ring gear (75 T, module 1.5) with the six curved drive slots
    pinion    15 T, module 1.5, 5 mm D-shaft, M3 set screw
    lid       closes the housing; its sleeve guides the kibble onto the blades
    funnel    hopper adapter, screwed onto the lid with the lid screws

All dimensions in mm. The blade outline and the pin paths below are the ones
--check verifies, so a changed parameter is checked before it is printed.
"""
import argparse
import math
import os

# ─────────────────────────────── iris ───────────────────────────────
N = 6  # blades
R_AP = 21.0  # aperture radius when open: 42 mm, three to four kibbles side by side
CLEAR = 0.6  # gap between the open blades and the aperture
R1 = R_AP + CLEAR  # blade inner edge
RP = 38.0  # pivot pin circle
RO = 43.0  # blade outer radius at the pivot end
A0 = 9.0  # blade tail behind its pivot (deg)
A1 = 78.0  # blade tip ahead of its pivot (deg)
PHI_T = 20.0  # the outer edge tapers towards the tip from here (deg)
W_TIP = 7.0  # blade width at the tip
D_RAD, D_ANG = 38.0, 13.0  # drive pin, polar, in the open frame of blade 0

# Closed hard stop. The blades meet at 33 deg, but from 32 deg three of them stack
# at the centre, more than the cavity holds. At 31.5 deg a 2 mm hole is left:
# nothing a cat eats (kibble is 8-12 mm) passes it.
ALPHA_MAX = 31.5
MAX_CLOSED_OPENING = 3.0  # mm, checked at ALPHA_MAX
K_RING = 1.0  # ring turn per degree of blade swing

# ───────────────────────────── stack-up ─────────────────────────────
BLADE_T = 1.2
CAVITY = 3.0  # two blade layers and clearance: never more than two overlap (--check)
FLOOR_T = 4.0
RING_T = 6.0
LID_T = 3.0
GAP = 0.3  # running clearance

Z_BLADES = FLOOR_T  # floor top, the blades lie here
Z_RING = FLOOR_T + CAVITY  # ledge the ring runs on
Z_TOP = Z_RING + RING_T + GAP  # top of the base wall, the lid sits here

PIVOT_PIN_D = 3.6  # printed upright on the floor
PIVOT_HOLE_D = 4.0  # in the blade
DRIVE_PIN_D = 4.0  # printed upright on the blade
DRIVE_PIN_H = (CAVITY - BLADE_T) + RING_T - 1.0  # reaches 1 mm below the ring top
SLOT_W = 4.5  # drive slot in the ring
R_RING_BORE = 28.0  # clears the lid sleeve

# ───────────────────────────── gears ─────────────────────────────
MODULE = 1.5
TEETH_RING, TEETH_PINION = 75, 15  # 5:1: 157.5 deg of motor for the whole stroke
PRESSURE_ANGLE = 20.0
BACKLASH = 0.2
CENTER_DIST = MODULE * (TEETH_RING + TEETH_PINION) / 2  # 67.5, motor axis on +x

# ───────────────────────────── housing ─────────────────────────────
R_LEDGE = 47.0  # blade cavity wall; the blades sweep out to 45.6
R_RING_POCKET = TEETH_RING * MODULE / 2 + MODULE + 1.0
R_PINION_POCKET = TEETH_PINION * MODULE / 2 + MODULE + 1.25
R_HOUSING = 65.0
LID_SCREW_R = 61.5
LID_SCREW_ANGLES = (30, 90, 150, 210, 270, 330)  # the motor is at 0 deg
LID_SCREW_PILOT_D = 2.8  # M3 self-tapping into the base wall
SCREW_D = 3.4

NEMA_HOLE = 31.0  # NEMA 17 screw square
NEMA_PILOT_D = 22.6  # the 22 mm centering boss
NEMA_BODY = 42.3
SHAFT_D, SHAFT_FLAT = 5.15, 4.65  # D-shaft: diameter, and flat to the far side
M3_HEAD_D, M3_HEAD_SEAT = 6.2, 3.5  # counterbore and the floor left under the head

WALL = 2.4
SLEEVE_BOTTOM = Z_BLADES + 2 * BLADE_T + GAP  # just above the blade stack
FUNNEL_H, FUNNEL_TOP_R, COLLAR_H = 32.0, 50.0, 15.0


# ═════════════════════════════ geometry ═════════════════════════════
def rot(p, deg, origin=(0.0, 0.0)):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    x, y = p[0] - origin[0], p[1] - origin[1]
    return (origin[0] + c * x - s * y, origin[1] + s * x + c * y)


def polar(r, deg):
    return (r * math.cos(math.radians(deg)), r * math.sin(math.radians(deg)))


def r_out(phi):
    """Outer edge of the blade: full width at the pivot, a smooth taper to the tip."""
    if phi <= PHI_T:
        return RO
    t = (phi - PHI_T) / (A1 - PHI_T)
    return RO + (R1 + W_TIP - RO) * (0.5 - 0.5 * math.cos(math.pi * t))


def blade_outline(n=120):
    """Blade 0, open, as a closed polygon (counter-clockwise)."""
    phis = [-A0 + (A1 + A0) * k / n for k in range(n + 1)]
    outer = [polar(r_out(phi), phi) for phi in phis]
    inner = [polar(R1, phi) for phi in reversed(phis)]
    return outer + inner


def drive_pin(alpha):
    """Drive pin of blade 0 after a swing of alpha about its pivot."""
    return rot(polar(D_RAD, D_ANG), alpha, (RP, 0.0))


def slot_path(n=70):
    """The drive pin's path seen from the ring, which turns K_RING * alpha."""
    return [rot(drive_pin(ALPHA_MAX * k / n), -K_RING * ALPHA_MAX * k / n) for k in range(n + 1)]


def blade_segments(n=24):
    phis = [-A0 + (A1 + A0) * k / n for k in range(n + 1)]
    outer = [polar(r_out(phi), phi) for phi in phis]
    inner_start, inner_end = polar(R1, A1), polar(R1, -A0)
    return [
        ('spline', outer),
        ('line', outer[-1], inner_start),
        ('arc', inner_start, polar(R1, (A1 - A0) / 2), inner_end),
        ('line', inner_end, outer[0]),
    ]


def gear_segments(teeth, module, pressure_angle=PRESSURE_ANGLE, backlash=BACKLASH, steps=8):
    rp = teeth * module / 2
    rb = rp * math.cos(math.radians(pressure_angle))
    ra = rp + module
    rf = rp - 1.25 * module

    def inv(r):
        if r <= rb:
            return 0.0
        a = math.acos(rb / r)
        return math.tan(a) - a

    psi = math.pi / (2 * teeth) - backlash / (2 * rp)
    half = lambda r: max(psi + inv(rp) - inv(max(r, rb)), 0.0)
    pt = lambda r, a: (r * math.cos(a), r * math.sin(a))
    r0 = max(rf, rb)
    flank_r = [r0 + (ra - r0) * k / steps for k in range(steps + 1)]
    segs = []
    for i in range(teeth):
        c = 2 * math.pi * i / teeth
        nxt = 2 * math.pi * (i + 1) / teeth
        rising = [pt(r, c - half(r)) for r in flank_r]
        falling = [pt(r, c + half(r)) for r in reversed(flank_r)]
        if rf < rb:
            segs.append(('line', pt(rf, c - half(rf)), rising[0]))
        segs.append(('spline', rising))
        segs.append(('arc', rising[-1], pt(ra, c), falling[0]))
        segs.append(('spline', falling))
        root_start = pt(rf, c + half(rf))
        if rf < rb:
            segs.append(('line', falling[-1], root_start))
        segs.append(('arc', root_start, pt(rf, (c + half(rf) + nxt - half(rf)) / 2), pt(rf, nxt - half(rf))))
    return segs


def slot_segments(path, width):
    h = width / 2
    left, right = [], []
    for k, p in enumerate(path):
        a = path[max(k - 1, 0)]
        b = path[min(k + 1, len(path) - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        nx, ny = -dy / length, dx / length
        left.append((p[0] + nx * h, p[1] + ny * h))
        right.append((p[0] - nx * h, p[1] - ny * h))

    def cap_mid(a, b, center):
        # the point of the half circle from a to b, away from the path
        mx, my = (a[0] + b[0]) / 2 - center[0], (a[1] + b[1]) / 2 - center[1]
        d = math.hypot(mx, my)
        return (center[0] + mx / d * h, center[1] + my / d * h) if d > 1e-9 else center

    def end_mid(k_end, k_prev):
        tx, ty = path[k_end][0] - path[k_prev][0], path[k_end][1] - path[k_prev][1]
        t = math.hypot(tx, ty)
        return (path[k_end][0] + tx / t * h, path[k_end][1] + ty / t * h)

    right = list(reversed(right))
    return [
        ('spline', left),
        ('arc', left[-1], end_mid(-1, -2), right[0]),
        ('spline', right),
        ('arc', right[-1], end_mid(0, 1), left[0]),
    ]


def housing_tangent_polygon():
    """With a circle of R_HOUSING, the convex outline of the housing and the motor."""
    h = NEMA_BODY / 2 + 2
    far = [(CENTER_DIST + h, h), (CENTER_DIST + h, -h)]
    tangents = []
    for x, y in far:
        d = math.hypot(x, y)
        a = math.degrees(math.atan2(y, x)) + math.copysign(math.degrees(math.acos(R_HOUSING / d)), y)
        tangents.append(polar(R_HOUSING, a))
    return [(0.0, 0.0), tangents[1], far[1], far[0], tangents[0]]


def check():
    """The kinematics, on the same outline and pin paths as the solids."""
    from shapely import affinity, prepared
    from shapely.geometry import Point, Polygon
    from shapely.ops import unary_union

    blade0 = Polygon(blade_outline()).union(Point(RP, 0).buffer(RO - RP, 64)).buffer(0)

    def blade(i, alpha):
        return affinity.rotate(affinity.rotate(blade0, alpha, origin=(RP, 0)), 360 * i / N, origin=(0, 0))

    aperture = Point(0, 0).buffer(R_AP, 256)
    ok = True

    print('swing  opening  layers')
    worst_layers = 0
    grid = [Point(x / 2, y / 2) for x in range(-96, 97) for y in range(-96, 97)]
    for alpha in [0, 6, 12, 18, 24, 27, 30, ALPHA_MAX]:
        blades = [blade(i, alpha) for i in range(N)]
        free = aperture.difference(unary_union(blades)).area
        prep = [prepared.prep(b) for b in blades]
        layers = max(sum(b.contains(p) for b in prep) for p in grid)
        worst_layers = max(worst_layers, layers)
        print(f'{alpha:5.1f}  {2 * math.sqrt(free / math.pi):5.1f} mm  {layers}')

    closed_free = aperture.difference(unary_union([blade(i, ALPHA_MAX) for i in range(N)])).area
    closed_opening = 2 * math.sqrt(closed_free / math.pi)
    open_intrusion = unary_union([blade(i, 0) for i in range(N)]).intersection(aperture).area
    reach = max(math.hypot(*c) for a in range(0, int(ALPHA_MAX) + 1) for i in range(N) for c in blade(i, a).exterior.coords)

    pin_hits = 0
    for a in [k * ALPHA_MAX / 20 for k in range(21)]:
        blades = [blade(i, a) for i in range(N)]
        for i in range(N):
            pins = [rot(rot((RP, 0), 0), 360 * i / N), rot(drive_pin(a), 360 * i / N)]
            for pin in pins:
                disc = Point(pin).buffer(DRIVE_PIN_D / 2 + 0.5, 32)
                for j in range(N):
                    if j != i and blades[j].intersection(disc).area > 0.05:
                        pin_hits += 1

    # pressure angle: slot normal against the pin's velocity about its pivot
    worst_pa = 0.0
    for k in range(1, 69):
        a = ALPHA_MAX * k / 70
        h = 0.01
        t_ring = [q - p for p, q in zip(rot(drive_pin(a - h), -K_RING * (a - h)), rot(drive_pin(a + h), -K_RING * (a + h)))]
        t_world = rot(t_ring, K_RING * a)
        v = [q - p for p, q in zip(drive_pin(a - h), drive_pin(a + h))]
        n = (-t_world[1], t_world[0])
        cosang = abs(n[0] * v[0] + n[1] * v[1]) / (math.hypot(*n) * math.hypot(*v))
        worst_pa = max(worst_pa, math.degrees(math.acos(min(1.0, cosang))))

    def report(name, value, good):
        nonlocal ok
        ok &= good
        print(f'{"ok " if good else "BAD"} {name}: {value}')

    print()
    report('blades in the open aperture (mm2)', round(open_intrusion, 3), open_intrusion < 0.01)
    report('opening at the closed stop (mm)', round(closed_opening, 1), closed_opening <= MAX_CLOSED_OPENING)
    report('most blades over one point', worst_layers, worst_layers * BLADE_T + 0.5 <= CAVITY)
    report('blade reach (mm), cavity wall at', f'{reach:.1f} < {R_LEDGE}', reach < R_LEDGE - 0.8)
    report('pins covered by another blade', pin_hits, pin_hits == 0)
    report('worst pressure angle of the ring slots (deg)', round(worst_pa, 1), worst_pa < 55)
    turn = K_RING * ALPHA_MAX
    print(f'    ring turn {turn:.1f} deg, motor {turn * TEETH_RING / TEETH_PINION:.1f} deg, '
          f'{turn * TEETH_RING / TEETH_PINION / 1.8 * 16:.0f} microsteps at 1/16')
    return ok


# ═════════════════════════════ solids ═════════════════════════════
def build_parts():
    """Every part as a solid in its assembled place, and assembly(alpha) for a swing."""
    from build123d import Align, Cone, Cylinder, Polygon, Pos, Rectangle, Rot, Circle, export_step, export_stl, extrude

    up = (Align.CENTER, Align.CENTER, Align.MIN)

    from build123d import Edge, Face, Vector, Wire

    def poly(pts):
        return Polygon(*pts, align=None)

    def curve_face(segments):
        edges = []
        for seg in segments:
            kind, pts = seg[0], [Vector(*p) for p in (seg[1] if seg[0] == 'spline' else seg[1:])]
            if kind == 'spline':
                edges.append(Edge.make_spline(pts))
            elif kind == 'arc':
                edges.append(Edge.make_three_point_arc(*pts))
            else:
                edges.append(Edge.make_line(*pts))
        return Face(Wire(edges))

    def cyl(r, z0, z1, x=0.0, y=0.0):
        return Pos(x, y, z0) * Cylinder(r, z1 - z0, align=up)

    def prism(face, z0, z1):
        return Pos(0, 0, z0) * extrude(face, amount=z1 - z0)

    # ── blade ──
    blade_face = curve_face(blade_segments()) + Pos(RP, 0) * Circle(RO - RP)
    blade_face = blade_face - Pos(RP, 0) * Circle(PIVOT_HOLE_D / 2)
    dx, dy = polar(D_RAD, D_ANG)
    blade = extrude(blade_face, amount=BLADE_T) + cyl(DRIVE_PIN_D / 2, BLADE_T - 0.01, BLADE_T + DRIVE_PIN_H, dx, dy)

    # ── ring gear ──
    ring_face = curve_face(gear_segments(TEETH_RING, MODULE)) - Circle(R_RING_BORE)
    slot = curve_face(slot_segments(slot_path(), SLOT_W))
    for i in range(N):
        ring_face = ring_face - Rot(0, 0, 360 * i / N) * slot
    ring = extrude(ring_face, amount=RING_T)

    # ── pinion ──
    pinion_h = RING_T - GAP
    bore = Circle(SHAFT_D / 2) - Pos(SHAFT_FLAT - SHAFT_D / 2 + 5, 0) * Rectangle(10, 10)
    gap_deg = 180 / TEETH_PINION  # a tooth gap: the set screw goes in between two teeth
    pinion_face = curve_face(gear_segments(TEETH_PINION, MODULE)) - Rot(0, 0, gap_deg) * bore
    set_screw = Rot(0, 0, gap_deg) * Pos(0, 0, pinion_h / 2) * Rot(0, 90, 0) * Cylinder(1.3, 20, align=up)
    pinion = extrude(pinion_face, amount=pinion_h) - set_screw

    # ── base ──
    outline = Circle(R_HOUSING) + poly(housing_tangent_polygon())
    base = prism(outline, 0, Z_TOP)
    base -= prism(Circle(R_RING_POCKET) + Pos(CENTER_DIST, 0) * Circle(R_PINION_POCKET), Z_RING, Z_TOP + 1)
    base -= prism(Circle(R_LEDGE), Z_BLADES, Z_RING + 0.01)
    # the bore is the outlet; the chute to the bowl belongs to the feeder stand
    base -= cyl(R_AP, -1, Z_TOP + 1)
    for i in range(N):
        x, y = polar(RP, 360 * i / N)
        base += cyl(PIVOT_PIN_D / 2, Z_BLADES - 0.01, Z_RING - 0.4, x, y)
    base -= cyl(NEMA_PILOT_D / 2, -1, Z_RING + 0.01, CENTER_DIST, 0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = CENTER_DIST + sx * NEMA_HOLE / 2, sy * NEMA_HOLE / 2
            base -= cyl(SCREW_D / 2, -1, Z_TOP + 1, x, y)
            base -= cyl(M3_HEAD_D / 2, M3_HEAD_SEAT, Z_TOP + 1, x, y)
    for a in LID_SCREW_ANGLES:
        x, y = polar(LID_SCREW_R, a)
        base -= cyl(LID_SCREW_PILOT_D / 2, Z_TOP - 10, Z_TOP + 1, x, y)

    # ── lid (printed upside down: plate on the bed, sleeve up) ──
    lid = prism(outline, Z_TOP, Z_TOP + LID_T)
    lid += cyl(R_AP + 2.0, SLEEVE_BOTTOM, Z_TOP + 0.01)
    lid -= cyl(R_AP, SLEEVE_BOTTOM - 1, Z_TOP + LID_T + 1)
    for a in LID_SCREW_ANGLES:
        x, y = polar(LID_SCREW_R, a)
        lid -= cyl(SCREW_D / 2, Z_TOP - 1, Z_TOP + LID_T + 1, x, y)

    # ── funnel: flange on the lid, cone up to the hopper collar ──
    z0 = Z_TOP + LID_T
    flange_r = LID_SCREW_R + 4.5
    funnel = cyl(flange_r, z0, z0 + 3.0)
    funnel += Pos(0, 0, z0) * Cone(R_AP + WALL + 1.0, FUNNEL_TOP_R + WALL, FUNNEL_H, align=up)
    funnel += cyl(FUNNEL_TOP_R + WALL, z0 + FUNNEL_H, z0 + FUNNEL_H + COLLAR_H)
    funnel -= Pos(0, 0, z0 - 0.01) * Cone(R_AP, FUNNEL_TOP_R, FUNNEL_H + 0.02, align=up)
    funnel -= cyl(FUNNEL_TOP_R, z0 + FUNNEL_H, z0 + FUNNEL_H + COLLAR_H + 1)
    for a in LID_SCREW_ANGLES:
        x, y = polar(LID_SCREW_R, a)
        funnel -= cyl(SCREW_D / 2, z0 - 1, z0 + 4, x, y)

    parts = {'base': base, 'blade': blade, 'ring': ring, 'pinion': pinion, 'lid': lid, 'funnel': funnel}

    def assembly(alpha):
        placed = [base, Pos(0, 0, Z_RING + GAP / 2) * Rot(0, 0, K_RING * alpha) * ring, lid, funnel]
        # the ring has a tooth on 0 deg, an odd-toothed pinion a gap on 180 deg: in mesh as placed
        placed.append(Pos(CENTER_DIST, 0, Z_RING + GAP) * Rot(0, 0, -K_RING * alpha * TEETH_RING / TEETH_PINION) * pinion)
        for i in range(N):
            # swing about the pivot, then to the blade's place on the circle
            b = Rot(0, 0, 360 * i / N) * Pos(RP, 0, Z_BLADES) * Rot(0, 0, alpha) * Pos(-RP, 0, 0) * blade
            placed.append(b)
        return placed

    return parts, assembly


def build():
    """STEP of every part in place (for CAD), STL of every part lying flat (for the slicer)."""
    from build123d import Compound, Pos, Rot, export_step, export_stl

    parts, assembly = build_parts()
    base, blade, ring, pinion, lid, funnel = (parts[k] for k in ('base', 'blade', 'ring', 'pinion', 'lid', 'funnel'))
    here = os.path.dirname(os.path.abspath(__file__))
    for sub in ('step', 'stl'):
        os.makedirs(os.path.join(here, sub), exist_ok=True)

    # printing orientation: every part flat on the bed
    print_pose = {
        'base': base,
        'blade': blade,
        'ring': ring,
        'pinion': pinion,
        'lid': Rot(180, 0, 0) * Pos(0, 0, -(Z_TOP + LID_T)) * lid,
        'funnel': Pos(0, 0, -(Z_TOP + LID_T)) * funnel,
    }
    for name, part in print_pose.items():
        export_stl(part, os.path.join(here, 'stl', f'{name}.stl'), tolerance=0.02, angular_tolerance=0.15)
        export_step(parts[name], os.path.join(here, 'step', f'{name}.step'))
        print(f'{name}: {part.volume / 1000:.1f} cm3')

    # the closed state is the same parts turned: a CAD tool shows it with a joint
    export_step(Compound(assembly(0)), os.path.join(here, 'step', 'assembly.step'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='check the kinematics only')
    args = parser.parse_args()
    good = check()
    if not good:
        raise SystemExit('the kinematics check failed, nothing exported')
    if not args.check:
        build()
