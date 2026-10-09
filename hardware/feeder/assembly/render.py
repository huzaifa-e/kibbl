"""
Pictures for the README: the feeder outside and cut through the chute, the electronics bay
from behind, the parts exploded, and what the camera sees of the bowl. Needs matplotlib and
trimesh next to build123d.

    python render.py
    python render.py --orbit    only the turning GIF (a few minutes)
    python render.py --feeding  only the cut-open portion GIF
"""
import math
import os
import tempfile

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

import feeder

HERE = os.path.dirname(os.path.abspath(__file__))
INK = '#2a1a12'
PAPER = '#f3e6cf'


def meshes(placed, light, tolerance=0.2, max_edge=None):
    """Triangles and shaded colours of (name, solid, colour), for one Poly3DCollection."""
    from build123d import export_stl
    import trimesh

    triangles, colors = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for k, (name, solid, color) in enumerate(placed):
            f = os.path.join(tmp, f'{k}.stl')
            export_stl(solid, f, tolerance=tolerance, angular_tolerance=0.3)
            mesh = trimesh.load(f)
            if max_edge:
                # small triangles: matplotlib sorts whole faces by depth, large ones show through
                v, t = trimesh.remesh.subdivide_to_size(mesh.vertices, mesh.faces, max_edge)
                mesh = trimesh.Trimesh(v, t)
            shade = 0.45 + 0.55 * np.clip(mesh.face_normals @ light, 0, 1)
            rgb = np.array(matplotlib.colors.to_rgb(color))
            triangles.append(mesh.triangles)
            colors.append(np.clip(rgb[None, :] * shade[:, None], 0, 1))
    return np.concatenate(triangles), np.concatenate(colors)


def everything():
    printed, bought, _ = feeder.assembly()
    items = printed + bought + [('EMONI board', feeder.board_solid()[0])]
    return [(n, s, feeder.color_of(n)) for n, s in items if not n.startswith('screw') and not n.startswith('grub')]


def draw(ax, items, light, lim, elev, azim, max_edge=6.0, zoom=1.0):
    light = np.array(light, dtype=float)
    triangles, colors = meshes(items, light / np.linalg.norm(light), max_edge=max_edge)
    ax.add_collection3d(Poly3DCollection(triangles, facecolors=colors, edgecolors=colors, linewidths=0.2))
    (x0, x1), (y0, y1), (z0, z1) = lim
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_zlim(z0, z1)
    ax.set_box_aspect((x1 - x0, y1 - y0, z1 - z0), zoom=zoom)
    ax.view_init(elev=elev, azim=azim)
    ax.set_facecolor(PAPER)
    ax.axis('off')


def outside_and_cut(path):
    from build123d import Box, Pos

    items = everything()
    # keep x > EYE_X: the cut runs through the eye, the chute and the iris outlet
    keep = Pos(feeder.EYE_X + 300, 0, 0) * Box(600, 1000, 1000)
    halves = [(n, s & keep, c) for n, s, c in items]
    halves = [(n, s, c) for n, s, c in halves if s.volume > 0.01]
    fig = plt.figure(figsize=(15, 9), facecolor=PAPER)
    lim = ((-110, 110), (-260, 100), (0, 400))
    for k, (its, elev, azim, title, light) in enumerate([
        (items, 18, -62, 'kibbl. feeder', (0.4, -0.7, 0.6)),
        (halves, 4, -178, 'cut through the eye, the chute and the iris outlet', (-0.9, -0.3, 0.4)),
    ]):
        ax = fig.add_subplot(1, 2, k + 1, projection='3d')
        draw(ax, its, light, lim, elev, azim, zoom=1.25)
        ax.set_title(title, color=INK, fontsize=13, weight='bold')
    fig.text(0.5, 0.03, 'hopper lid · hopper (1 kg) · shell · iris · body with the electronics · chute · tray and bowl',
             ha='center', color=INK, fontsize=10)
    fig.subplots_adjust(left=0, right=1, top=0.95, bottom=0.05, wspace=0)
    fig.savefig(path, dpi=100, facecolor=PAPER)
    plt.close(fig)


def bay(path):
    """The inside of the front wall, seen from behind: board, light tunnels, camera, chute."""
    from build123d import Box, Pos

    items = everything()
    window = Pos(0, -70, 95) * Box(230, 60, 190)  # the front 40 mm of the body, up to the deck
    keep = {'body', 'chute', 'EMONI board', 'camera module'}
    its = [(n, s & window, c) for n, s, c in items if n in keep]
    its = [(n, s, c) for n, s, c in its if s.volume > 0.01]
    fig = plt.figure(figsize=(12, 8), facecolor=PAPER)
    ax = fig.add_subplot(projection='3d')
    draw(ax, its, (0.2, 0.9, 0.4), ((-105, 105), (-110, -40), (0, 190)), 12, 75, max_edge=4.0, zoom=1.4)
    ax.set_title('the front wall from inside: EMONI board EHW0014-0011 (top side to the wall), camera in the eye, chute',
                 color=INK, fontsize=11, weight='bold')
    fig.subplots_adjust(left=0, right=1, top=0.95, bottom=0)
    fig.savefig(path, dpi=100, facecolor=PAPER)
    plt.close(fig)


def exploded(path):
    from build123d import Pos

    items = everything()
    lift = {'floor': -60, 'tray': -60, 'chute': -40, 'shell': 70, 'hopper': 140, 'hopper_lid': 190}
    placed = []
    for n, s, c in items:
        dz = lift.get(n, 0)
        if n.startswith('iris') or n.startswith(('motor', 'driver')):
            dz = 30
        if n == 'bowl':
            dz = -60
        placed.append((n, Pos(0, 0, dz) * s, c))
    fig = plt.figure(figsize=(10, 12), facecolor=PAPER)
    ax = fig.add_subplot(projection='3d')
    draw(ax, placed, (0.4, -0.7, 0.6), ((-110, 110), (-260, 100), (-130, 590)), 14, -58, zoom=1.1)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    fig.savefig(path, dpi=90, facecolor=PAPER)
    plt.close(fig)


def camera_view(path):
    """The bowl and spout in the image, for the standard lens and a 120 deg one."""
    rim, spout, dist = feeder.camera_view()
    fig, ax = plt.subplots(figsize=(8, 6), facecolor=PAPER)
    ax.set_facecolor(PAPER)
    h = math.tan(math.radians(feeder.CAM_HFOV / 2))
    v = math.tan(math.radians(feeder.CAM_VFOV / 2))
    xs, ys = [p[0] * h for p in rim], [p[1] * v for p in rim]
    ax.fill(xs, ys, color='#b8bcc2', alpha=0.6, ec=INK, lw=1.5, label='bowl rim, Ø %.0f' % feeder.BOWL_D)
    ax.plot([spout[0] * h], [spout[1] * v], 'o', color='#e0a526', ms=10, label='spout tip')
    for fov_h, fov_v, label, ls in ((feeder.CAM_HFOV, feeder.CAM_VFOV, f'standard lens {feeder.CAM_HFOV:.0f} × {feeder.CAM_VFOV:.0f}°', '-'),
                                    (100, 80, 'wide lens, 120° diagonal', '--')):
        th, tv = math.tan(math.radians(fov_h / 2)), math.tan(math.radians(fov_v / 2))
        ax.add_patch(plt.Rectangle((-th, -tv), 2 * th, 2 * tv, fill=False, ec=INK, lw=2, ls=ls, label=label))
    ax.set_aspect('equal')
    ax.set_xlim(-1.4, 1.4)
    ax.set_ylim(-1.1, 1.1)
    ax.axis('off')
    ax.legend(loc='lower center', ncol=2, frameon=False, fontsize=9, bbox_to_anchor=(0.5, -0.12))
    ax.set_title(f'what the camera sees: pitch {feeder.CAM_PITCH}°, {dist:.0f} mm to the middle of the bowl',
                 color=INK, fontsize=12, weight='bold')
    fig.tight_layout()
    fig.savefig(path, dpi=100, facecolor=PAPER)
    plt.close(fig)


def orbit(path, frames=36):
    """One turn around the closed feeder, then one with the housing's right side cut away: iris, motor, S42B, board."""
    from build123d import Box, Pos
    from PIL import Image

    items = everything()
    housing = {'body', 'shell', 'hopper', 'hopper_lid', 'floor'}
    # away: the housing right of the chute and behind the front wall, so the motor and its driver show
    away = Pos(30 + 100, 20, 200) * Box(200, 160, 500)
    cut = []
    for n, s, c in items:
        if n in housing:
            s = s - away
        cut.append((n, s, c))
    lim = ((-115, 115), (-260, 100), (0, 400))
    pics = []
    for its, title in ((items, 'kibbl. feeder'), (cut, 'side open: the motor and its S42B hang under the iris')):
        light = np.array([0.3, -0.6, 0.7])
        triangles, colors = meshes(its, light / np.linalg.norm(light), max_edge=8.0)
        for k in range(frames):
            azim = -60 + 360 * k / frames
            fig = plt.figure(figsize=(6.4, 7.2), facecolor=PAPER)
            ax = fig.add_subplot(projection='3d')
            ax.add_collection3d(Poly3DCollection(triangles, facecolors=colors, edgecolors=colors, linewidths=0.2))
            (x0, x1), (y0, y1), (z0, z1) = lim
            ax.set_xlim(x0, x1)
            ax.set_ylim(y0, y1)
            ax.set_zlim(z0, z1)
            ax.set_box_aspect((x1 - x0, y1 - y0, z1 - z0), zoom=1.2)
            ax.view_init(elev=18, azim=azim)
            ax.set_facecolor(PAPER)
            ax.axis('off')
            fig.text(0.5, 0.95, title, ha='center', color=INK, fontsize=10, weight='bold')
            fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
            fig.canvas.draw()
            pics.append(Image.frombuffer('RGBA', fig.canvas.get_width_height(), fig.canvas.buffer_rgba()).convert('RGB'))
            plt.close(fig)
    pics = [p.quantize(colors=96, method=Image.Quantize.MEDIANCUT) for p in pics]
    pics[0].save(path, save_all=True, append_images=pics[1:], duration=110, loop=0, optimize=True)


# ───────────────────────────── a portion, cut open ─────────────────────────────
G = 9810.0  # mm/s2
DT = 0.012  # simulated seconds per frame: slowed down about five times
FRICTION = 0.3  # kibble on printed PETG


def _tris(solid, max_edge=6.0):
    from build123d import export_stl
    import trimesh

    with tempfile.TemporaryDirectory() as tmp:
        f = os.path.join(tmp, 'p.stl')
        export_stl(solid, f, tolerance=0.2, angular_tolerance=0.3)
        mesh = trimesh.load(f)
    v, t = trimesh.remesh.subdivide_to_size(mesh.vertices, mesh.faces, max_edge)
    return v[t]


def _turn(tris, deg, x, y):
    """Turn triangles about the vertical axis through (x, y)."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    out = tris.copy()
    dx, dy = tris[..., 0] - x, tris[..., 1] - y
    out[..., 0] = x + c * dx - s * dy
    out[..., 1] = y + s * dx + c * dy
    return out


def _shade(tris, rgb, light):
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    shade = 0.45 + 0.55 * np.clip(np.abs(n @ light), 0, 1)
    return np.clip(np.asarray(rgb)[None, :] * shade[:, None], 0, 1)


QUARTER = ('body', 'shell', 'hopper', 'hopper_lid', 'floor', 'iris base', 'iris lid', 'iris funnel', 'iris ring', 'iris blade')
HALF_Y = ('motor', 'driver', 'iris pinion')  # cut through the motor axis
HALF_X = ('chute', 'bowl')  # cut through the iris axis


def _removed(p, name='body'):
    """The cut: housing and iris a quarter (front and left away), motor at its axis, chute and bowl at the middle."""
    x, y = p[..., 0], p[..., 1]
    if name.startswith(HALF_Y):
        return y < 0
    if name.startswith(HALF_X):
        return x < 0
    if name.startswith(QUARTER):
        return (x < 0) | (y < 0)
    return np.zeros(x.shape, bool)


def _inside(z):
    """Radius of the food's room above the iris at height z."""
    from iris import FUNNEL_H, LID_T, R_AP, Z_TOP
    z0 = feeder.Z_IRIS + Z_TOP + LID_T
    if z < z0:
        return R_AP
    if z < z0 + FUNNEL_H:
        return R_AP + (iris_mod().FUNNEL_TOP_R - R_AP) * (z - z0) / FUNNEL_H
    if z < feeder.Z_CONE:
        return feeder.SPIGOT_R
    return min(feeder.HOPPER_R, feeder.SPIGOT_R + (z - feeder.Z_CONE) * feeder.COT)


def iris_mod():
    import iris
    return iris


def kibble_paths(n_fall, rng):
    """Where every falling kibble is in every frame after its release: list of (release frame, [(x, y, z)])."""
    th = math.radians(feeder.CHUTE_ANGLE)
    a_slide = G * (math.sin(th) - FRICTION * math.cos(th))
    landed = []
    paths = []
    for k in range(n_fall):
        release = 30 + int(k * 40 / n_fall)
        r = 3.0
        while True:
            x, y = rng.uniform(2, 17), rng.uniform(-14, 14)
            if math.hypot(x, y) < 17:
                break
        z = feeder.Z_IRIS + 12 + rng.uniform(0, 6)
        pts, vz, v = [], 0.0, None
        phase = 'fall'
        while True:
            if phase == 'fall':
                vz -= G * DT
                z += vz * DT
                floor = feeder.floor_z(y) + r
                if z <= floor:
                    z, phase, v = floor, 'slide', abs(vz) * math.sin(th) * 0.3
            elif phase == 'slide':
                v += a_slide * DT
                y -= v * math.cos(th) * DT
                if y <= feeder.Y_EXIT:
                    phase, vy, vz = 'fly', -v * math.cos(th), -v * math.sin(th)
                    y = feeder.Y_EXIT
                z = feeder.floor_z(y) + r
            else:
                y += vy * DT
                vz -= G * DT
                z += vz * DT
                rest = feeder.TRAY_T + 1.2 + r
                if z <= rest:
                    # it bounces and rolls a little: a heap, not a tower
                    x = min(max(x + rng.uniform(0, 25), 3), 50)
                    y += rng.uniform(-22, 22)
                    near = sum(1 for p in landed if math.hypot(p[0] - x, p[1] - y) < 9)
                    dy = y - feeder.BOWL_Y
                    if math.hypot(x, dy) > 52:
                        x, y = x * 52 / math.hypot(x, dy), feeder.BOWL_Y + dy * 52 / math.hypot(x, dy)
                    z = rest + 3.5 * min(near, 2)
                    pts.append((x, y, z))
                    landed.append((x, y, z))
                    break
            pts.append((x, y, z))
        paths.append((release, pts))
    return paths


def pile_points(rng):
    """The food left in the hopper, in the kept half: lowest first."""
    pts = []
    step = 8.5
    z = feeder.Z_IRIS + 10
    while z < feeder.Z_CONE + 45:
        r = _inside(z) - 4
        for x in np.arange(-r, r + 0.1, step):
            for y in np.arange(-r, r + 0.1, step):
                p = (x + rng.uniform(-2, 2), y + rng.uniform(-2, 2), z + rng.uniform(-2, 2))
                if math.hypot(p[0], p[1]) < r and not _removed(np.array(p), 'hopper'):
                    pts.append(p)
        z += step * 0.8
    return pts


def feeding(path, frames=132, preview=None):
    """Cut open: the motor turns the ring, the iris opens, food falls through the chute into the bowl, the iris closes."""
    from build123d import Box, Pos
    from PIL import Image
    import trimesh

    iris = iris_mod()
    rng = np.random.default_rng(3)
    light = np.array([-0.6, -0.5, 0.65])
    light /= np.linalg.norm(light)
    printed, bought, _ = feeder.assembly()
    left, front = Pos(-200, 0, 200) * Box(400, 800, 800), Pos(0, -200, 200) * Box(800, 400, 800)
    moving = ('iris ring', 'iris pinion', 'iris blade', 'motor shaft')
    static_t, static_c, move = [], [], []
    for name, solid in printed + bought:
        if name.startswith(('screw', 'grub')) or name in ('camera module',):
            continue
        rgb = matplotlib.colors.to_rgb(feeder.color_of(name))
        if name.startswith(moving):
            t = _tris(solid, 4.0)
            move.append((name, t, rgb))
            continue
        away = front if name.startswith(HALF_Y) else left if name.startswith(HALF_X) else left + front if name.startswith(QUARTER) else None
        if away is not None:
            solid = solid - away
            if solid.volume < 0.01:
                continue
        t = _tris(solid)
        static_t.append(t)
        static_c.append(_shade(t, rgb, light))
    static_t, static_c = np.concatenate(static_t), np.concatenate(static_c)

    shape = trimesh.creation.icosphere(subdivisions=1, radius=1.0)
    base = shape.vertices[shape.faces] * np.array([5.0, 4.2, 3.0])

    def piece(p, rot):
        return base @ rot.T + np.asarray(p)

    def random_rot():
        q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        return q

    n_fall = 40
    paths = kibble_paths(n_fall, rng)
    pile = pile_points(rng)
    pile_rot = [random_rot() for _ in pile]
    fall_rot = [random_rot() for _ in paths]
    spin = [rng.normal(size=3) * 0.25 for _ in paths]
    kibble_rgb = [np.array(matplotlib.colors.to_rgb('#8a5a2b')) * rng.uniform(0.8, 1.1) for _ in range(len(pile) + n_fall)]

    def alpha_at(f):
        """Blade swing: ALPHA_MAX closed, 0 open."""
        a = iris.ALPHA_MAX
        ease = lambda u: 0.5 - 0.5 * math.cos(math.pi * min(max(u, 0), 1))
        if f < 8:
            return a
        if f < 26:
            return a * (1 - ease((f - 8) / 18))
        if f < 74:
            return 0.0
        return a * ease((f - 74) / 18)

    lim = ((-120, 120), (-260, 100), (0, 400))
    pics = []
    for f in (preview or range(frames)):
        alpha = alpha_at(f)
        tris, cols = [static_t], [static_c]
        for name, t, rgb in move:
            if name == 'iris ring':
                t = _turn(t, iris.K_RING * alpha, 0, 0)
            elif name.startswith('iris blade'):
                i = int(name.split()[2]) - 1
                px, py = iris.polar(iris.RP, 360 * i / iris.N)
                t = _turn(t, alpha, px, py)
            else:  # pinion and shaft
                t = _turn(t, -iris.motor_turn(alpha), iris.CENTER_DIST, 0)
            keep = ~_removed(t.mean(axis=1), name)
            tris.append(t[keep])
            cols.append(_shade(t[keep], rgb, light))
        # the food: the pile sinks by what has fallen, the falling ones follow their paths
        gone = sum(1 for rel, _ in paths if f >= rel)
        shown = len(pile) - int(gone * 1.6)
        order = sorted(range(len(pile)), key=lambda k: pile[k][2])
        for k in order[:max(shown, 0)]:
            t = piece(pile[k], pile_rot[k])
            tris.append(t)
            cols.append(_shade(t, kibble_rgb[k], light))
        for j, (rel, pts) in enumerate(paths):
            if f < rel:
                continue
            step = min(f - rel, len(pts) - 1)
            ang = spin[j] * step if step < len(pts) - 1 else spin[j] * (len(pts) - 1)
            rx = trimesh.transformations.euler_matrix(*ang)[:3, :3]
            t = piece(pts[step], fall_rot[j] @ rx)
            tris.append(t)
            cols.append(_shade(t, kibble_rgb[len(pile) + j], light))
        tris, cols = np.concatenate(tris), np.concatenate(cols)

        fig = plt.figure(figsize=(9, 9), facecolor=PAPER)
        ax = fig.add_subplot(projection='3d')
        ax.add_collection3d(Poly3DCollection(tris, facecolors=cols, edgecolors=cols, linewidths=0.15))
        (x0, x1), (y0, y1), (z0, z1) = lim
        ax.set_xlim(x0, x1)
        ax.set_ylim(y0, y1)
        ax.set_zlim(z0, z1)
        ax.set_box_aspect((x1 - x0, y1 - y0, z1 - z0), zoom=1.0)
        ax.view_init(elev=18, azim=-112)
        ax.set_facecolor(PAPER)
        ax.axis('off')
        state = 'closed' if alpha >= iris.ALPHA_MAX - 1e-6 else 'open' if alpha == 0 else 'opening' if f < 50 else 'closing'
        fig.text(0.5, 0.93, 'a portion, cut open', ha='center', color=INK, fontsize=12, weight='bold')
        fig.text(0.5, 0.905, f'motor {iris.motor_turn(iris.ALPHA_MAX - alpha):.0f}° from closed · iris {state} · slowed down',
                 ha='center', color=INK, fontsize=9)
        fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
        fig.canvas.draw()
        pics.append(Image.frombuffer('RGBA', fig.canvas.get_width_height(), fig.canvas.buffer_rgba()).convert('RGB'))
        plt.close(fig)
        print(f'frame {f + 1}/{frames}', end='\r', flush=True)
    # one crop for all frames: the box around everything drawn
    from PIL import ImageChops
    bg = Image.new('RGB', pics[0].size, PAPER)
    boxes = [ImageChops.difference(p, bg).getbbox() for p in pics]
    box = (min(b[0] for b in boxes) - 12, min(b[1] for b in boxes) - 12, max(b[2] for b in boxes) + 12, max(b[3] for b in boxes) + 12)
    pics = [p.crop(box) for p in pics]
    if preview:
        for f, pic in zip(preview, pics):
            pic.save(path.replace('.gif', f'-{f}.png'))
        return
    pics = [p.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for p in pics]
    pics[0].save(path, save_all=True, append_images=pics[1:], duration=60, loop=0, optimize=True)


if __name__ == '__main__':
    import sys

    os.makedirs(os.path.join(HERE, 'images'), exist_ok=True)
    if '--feeding' in sys.argv:
        feeding(os.path.join(HERE, 'images', 'feeding.gif'))
        raise SystemExit
    orbit(os.path.join(HERE, 'images', 'feeder-orbit.gif'))
    if '--orbit' in sys.argv:
        raise SystemExit
    camera_view(os.path.join(HERE, 'images', 'camera-view.png'))
    outside_and_cut(os.path.join(HERE, 'images', 'feeder.png'))
    bay(os.path.join(HERE, 'images', 'bay.png'))
    exploded(os.path.join(HERE, 'images', 'exploded.png'))
