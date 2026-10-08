"""
Pictures for the README: the iris from above at three openings, the parts
exploded, the whole assembly with the motor and its driver, outside and cut open,
the stress profile over the stroke, and the iris opening and closing as a GIF. Needs matplotlib, shapely and trimesh next to build123d.

    python render.py
"""
import math
import os
import tempfile

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from shapely import affinity
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

import iris

HERE = os.path.dirname(os.path.abspath(__file__))
INK = '#2a1a12'
PAPER = '#f3e6cf'
BLADES = ['#d9622b', '#a63d1f', '#e0a526', '#7f9a2e', '#7b3f61', '#3d7a73']


def blade(i, alpha):
    b0 = Polygon(iris.blade_outline()).union(Point(iris.RP, 0).buffer(iris.RO - iris.RP, 64)).buffer(0)
    return affinity.rotate(affinity.rotate(b0, alpha, origin=(iris.RP, 0)), 360 * i / iris.N, origin=(0, 0))


def top_views(path):
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.4), facecolor=PAPER)
    aperture = Point(0, 0).buffer(iris.R_AP, 256)
    for ax, alpha in zip(axes, (0, iris.ALPHA_MAX * 0.6, iris.ALPHA_MAX)):
        ax.set_facecolor(PAPER)
        ax.add_patch(plt.Circle((0, 0), iris.R_LEDGE, color='#1a0f0a', zorder=0))
        blades = [blade(i, alpha) for i in range(iris.N)]
        for i, b in enumerate(blades):
            x, y = b.exterior.xy
            ax.fill(x, y, color=BLADES[i], alpha=0.92, ec=INK, lw=1.4, zorder=2 + 10 * (i % 2) + i)  # upper blades over the lower
            px, py = iris.polar(iris.RP, 360 * i / iris.N)
            dx, dy = iris.rot(iris.drive_pin(alpha), 360 * i / iris.N)
            ax.add_patch(plt.Circle((px, py), iris.PIVOT_PIN_D / 2, color=PAPER, ec=INK, zorder=30))
            ax.add_patch(plt.Circle((dx, dy), iris.DRIVE_PIN_D / 2, color=INK, zorder=30))
        free = aperture.difference(unary_union(blades)).area
        ax.add_patch(plt.Circle((0, 0), iris.R_AP, fill=False, ls='--', ec=PAPER, lw=1, zorder=40))
        ax.set_title(f'swing {alpha:.1f}°  ·  opening {2 * math.sqrt(free / math.pi):.0f} mm', color=INK, fontsize=11, weight='bold')
        ax.set_xlim(-50, 50)
        ax.set_ylim(-50, 50)
        ax.set_aspect('equal')
        ax.axis('off')
    fig.tight_layout()
    fig.savefig(path, dpi=130, facecolor=PAPER)
    plt.close(fig)


def meshes(placed, light, tolerance=0.1, max_edge=None):
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


def exploded(path):
    from build123d import Pos, Rot

    parts, _ = iris.build_parts()
    rp = iris.RP
    lift = {'base': 0, 'blades': 22, 'ring': 70, 'pinion': 70, 'lid': 104, 'funnel': 134}
    placed = [
        ('base', parts['base'], '#8b5a3c'),
        ('ring', Pos(0, 0, iris.Z_RING + lift['ring']) * parts['ring'], '#e0a526'),
        ('pinion', Pos(iris.CENTER_DIST, 0, iris.Z_RING + lift['pinion']) * parts['pinion'], '#7f9a2e'),
        ('lid', Pos(0, 0, lift['lid']) * parts['lid'], '#c9b18f'),
        ('funnel', Pos(0, 0, lift['funnel']) * parts['funnel'], '#d9622b'),
    ]
    for i in range(iris.N):
        z, part = (iris.Z_UPPER + 12, parts['blade_upper']) if i % 2 else (iris.Z_BLADES, parts['blade'])
        b = Rot(0, 0, 360 * i / iris.N) * Pos(rp, 0, z + lift['blades']) * Pos(-rp, 0, 0) * part
        placed.append((f'blade{i}', b, BLADES[i]))

    fig = plt.figure(figsize=(8, 9), facecolor=PAPER)
    ax = fig.add_subplot(projection='3d')
    ax.set_facecolor(PAPER)
    light = np.array([0.4, -0.5, 0.8])
    light /= np.linalg.norm(light)
    # one collection for all parts: matplotlib orders faces by depth within a collection only
    triangles, colors = meshes(placed, light)
    ax.add_collection3d(Poly3DCollection(triangles, facecolors=colors, edgecolors='none'))
    ax.set_xlim(-70, 95)
    ax.set_ylim(-80, 80)
    ax.set_zlim(-30, 208)
    ax.set_box_aspect((165, 160, 230))
    ax.view_init(elev=24, azim=-58)
    ax.axis('off')
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=PAPER)
    plt.close(fig)


def assembled(path):
    """The whole feeder iris with motor, driver and screws: outside, and cut through the motor axis."""
    from build123d import Box, Pos

    parts, assembly = iris.build_parts()
    alpha = iris.ALPHA_MAX * 0.6
    placed = []
    for name, solid in assembly(alpha) + iris.hardware(alpha):
        color = BLADES[int(name.split()[1]) - 1] if name.startswith('blade') else iris.color_of(name)
        placed.append((name, solid, color))
    # keep the half behind the plane through both axes, so the cut faces the camera
    behind = Pos(0, 150, 0) * Box(400, 300, 400)
    halves = [(n, s & behind, c) for n, s, c in placed]
    halves = [(n, s, c) for n, s, c in halves if s.volume > 0.01]

    fig = plt.figure(figsize=(14, 6.5), facecolor=PAPER)
    views = [
        (placed, np.array([0.4, -0.5, 0.8]), 22, -58, 'assembled'),
        (halves, np.array([0.3, -0.9, 0.5]), 14, -78, 'cut through the motor axis'),
    ]
    for k, (items, light, elev, azim, title) in enumerate(views):
        ax = fig.add_subplot(1, 2, k + 1, projection='3d')
        ax.set_facecolor(PAPER)
        triangles, colors = meshes(items, light / np.linalg.norm(light), max_edge=4.0)
        # edges in the face colour close the antialiasing seams between the small triangles
        ax.add_collection3d(Poly3DCollection(triangles, facecolors=colors, edgecolors=colors, linewidths=0.3))
        ax.set_xlim(-70, 95)
        ax.set_ylim(-80, 80)
        ax.set_zlim(-60, 70)
        ax.set_box_aspect((165, 160, 130), zoom=1.35)
        ax.view_init(elev=elev, azim=azim)
        ax.set_title(title, color=INK, fontsize=12, weight='bold')
        ax.axis('off')
    fig.text(0.5, 0.04, 'funnel · lid · ring gear and pinion · six blades · base · NEMA 17 (17HS4401) · BTT S42B v1.0',
             ha='center', color=INK, fontsize=10)
    fig.subplots_adjust(left=0, right=1, top=0.94, bottom=0.06, wspace=0)
    fig.savefig(path, dpi=110, facecolor=PAPER)
    plt.close(fig)


def opening(alpha):
    free = Point(0, 0).buffer(iris.R_AP, 256).difference(unary_union([blade(i, alpha) for i in range(iris.N)])).area
    return 2 * math.sqrt(free / math.pi)


# one hue, light to dark: the higher the current, the darker the line
CURRENTS = [(0.3, '#86b6ef', 'recommended'), (1.0, '#2a78d6', ''), (1.7, '#104281', 'rated')]
SURFACE, TEXT, MUTED, GRID = '#fcfcfb', '#0b0b0b', '#52514e', '#e4e3df'


def stress_profile(path):
    """Stress in every loaded part over the stroke, one blade jammed, against PLA and PETG."""
    alphas = [iris.ALPHA_MAX * k / 40 for k in range(41)]
    openings = [opening(a) for a in alphas]
    parts = [('drive pin', 'bending across the layers'), ('pivot pin', 'bending across the layers'),
             ('pivot hole', 'bearing in the blade'), ('D-bore', 'bearing on the shaft flat'),
             ('pinion tooth', 'root bending'), ('ring tooth', 'root bending')]
    fig, axes = plt.subplots(2, 3, figsize=(13, 7.6), facecolor=SURFACE, sharex=True)
    for ax, (name, what) in zip(axes.flat, parts):
        ax.set_facecolor(SURFACE)
        direction = iris.LOAD_DIRECTION[name]
        top = 0
        for amps, color, note in CURRENTS:
            ys = [iris.loads(a, amps)[name] for a in alphas]
            top = max(top, max(ys))
            ax.plot(openings, ys, color=color, lw=2, solid_capstyle='round', label=f'{amps:.1f} A' + (f' ({note})' if note else ''))
            ax.annotate(f'{amps:.1f} A', (openings[-1], ys[-1]), xytext=(4, 0), textcoords='offset points', va='center', fontsize=8, color=MUTED)
        for mat, ls in (('PLA', '-'), ('PETG', (0, (4, 3)))):
            strength = iris.MATERIALS[mat][direction]
            ax.axhline(strength, color=TEXT, lw=1, ls=ls)
            ax.axhline(strength / 2, color=MUTED, lw=0.8, ls=ls, alpha=0.6)
            ax.annotate(f'{mat} {strength:.0f}', (openings[0], strength), xytext=(2, 3), textcoords='offset points', fontsize=8, color=TEXT)
            top = max(top, strength)
        ax.set_ylim(0, top * 1.12)
        ax.set_xlim(openings[0] + 1, openings[-1] - 5)
        ax.set_title(f'{name}  ·  {what}', fontsize=10, color=TEXT, loc='left', weight='bold')
        ax.grid(axis='y', color=GRID, lw=0.8)
        ax.tick_params(colors=MUTED, labelsize=8)
        for side in ('top', 'right'):
            ax.spines[side].set_visible(False)
        for side in ('left', 'bottom'):
            ax.spines[side].set_color(GRID)
    for ax in axes[:, 0]:
        ax.set_ylabel('MPa', color=MUTED, fontsize=9)
    for ax in axes[1]:
        ax.set_xlabel('opening (mm), closing to the right', color=MUTED, fontsize=9)
    handles, labels = axes[0, 0].get_legend_handles_labels()
    handles += [plt.Line2D([], [], color=TEXT, lw=1), plt.Line2D([], [], color=TEXT, lw=1, ls=(0, (4, 3))),
                plt.Line2D([], [], color=MUTED, lw=0.8, alpha=0.6)]
    labels += ['PLA strength', 'PETG strength', 'half of it: safety 2']
    fig.legend(handles, labels, loc='lower center', ncol=6, frameon=False, fontsize=9, labelcolor=TEXT)
    fig.suptitle('One blade jammed, the S42B pushing: stress over the stroke', color=TEXT, fontsize=13, weight='bold', x=0.01, ha='left')
    fig.tight_layout(rect=(0, 0.05, 1, 0.96))
    fig.savefig(path, dpi=110, facecolor=SURFACE)
    plt.close(fig)


def levels(path):
    """Side cut through overlapping blades: the lower ones on the floor, the upper ones on top."""
    from shapely.geometry import LineString

    fig, axes = plt.subplots(2, 2, figsize=(13, 6.6), facecolor=PAPER, gridspec_kw={'width_ratios': [1, 2.2]})
    for row, a in enumerate((0, iris.ALPHA_MAX * 0.75)):
        bl = [blade(i, a) for i in range(iris.N)]
        ov = bl[0].intersection(bl[1]); cx, cy = ov.centroid.x, ov.centroid.y
        ang = math.atan2(cy, cx); d = (math.cos(ang), math.sin(ang))
        # cut line: through the overlap, tangential (across both blades)
        t = (-d[1], d[0]); L = 40
        line = LineString([(cx - t[0]*L, cy - t[1]*L), (cx + t[0]*L, cy + t[1]*L)])
        ax = axes[row, 0]; ax.set_facecolor(PAPER)
        ax.add_patch(plt.Circle((0, 0), iris.R_LEDGE, color='#1a0f0a'))
        for i, b in enumerate(bl):
            x, y = b.exterior.xy; ax.fill(x, y, color=BLADES[i], ec=INK, lw=1, zorder=2 + 10 * (i % 2) + i)
        ax.plot(*line.xy, color='white', lw=1.5, ls='--', zorder=50)
        ax.set_xlim(-50, 50); ax.set_ylim(-50, 50); ax.set_aspect('equal'); ax.axis('off')
        ax.set_title(f'{opening(a):.0f} mm open: the cut', color=INK, fontsize=10, weight='bold')
        ax = axes[row, 1]; ax.set_facecolor(PAPER)
        ax.axhspan(iris.Z_BLADES - 1.0, iris.Z_BLADES, color='#8b5a3c')
        ax.text(-L + 1, iris.Z_BLADES - 0.6, 'base floor', color=PAPER, fontsize=8, va='center')
        ax.axhline(iris.Z_RING + iris.GAP / 2, color=INK, lw=1, ls=':'); ax.text(-L + 1, iris.Z_RING + iris.GAP / 2 + 0.12, 'underside of the ring', fontsize=8, color=INK)
        for i, b in enumerate(bl):
            inter = line.intersection(b)
            segs = [inter] if inter.geom_type == 'LineString' else list(getattr(inter, 'geoms', []))
            z = iris.Z_UPPER if i % 2 else iris.Z_BLADES
            for sgm in segs:
                if sgm.is_empty: continue
                s0, s1 = sorted(line.project(Point(p)) - L for p in sgm.coords)
                ax.add_patch(plt.Rectangle((s0, z), s1 - s0, iris.BLADE_T, color=BLADES[i], ec=INK, lw=0.8))
                ax.text((s0 + s1) / 2, z + iris.BLADE_T / 2, f'blade {i + 1}', ha='center', va='center', fontsize=8, color='white', weight='bold')
        ax.set_xlim(-L, L); ax.set_ylim(iris.Z_BLADES - 1.0, iris.Z_RING + 0.6)
        ax.set_ylabel('height (mm), stretched', fontsize=8, color=INK); ax.set_xlabel('along the cut (mm)', fontsize=8, color=INK)
        ax.set_title(f'side view of the cut: lower blades on the floor, upper blades on top, {iris.LEVEL_GAP} mm apart', color=INK, fontsize=10, weight='bold', loc='left')
        for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
    fig.tight_layout(); fig.savefig(path, dpi=100, facecolor=PAPER)
    plt.close(fig)


def animation(path, frames=36):
    """The mechanism opening and closing (lid and funnel off), and the iris from above."""
    from matplotlib.animation import FuncAnimation, PillowWriter

    parts, assembly = iris.build_parts()
    light = np.array([0.4, -0.5, 0.8])
    light /= np.linalg.norm(light)
    pivots = {f'blade {i + 1}': (*iris.polar(iris.RP, 360 * i / iris.N), 1.0) for i in range(iris.N)}
    motor_axis = (iris.CENTER_DIST, 0.0)
    # every part is meshed once, closed or open it is the same part turned about its axis
    moving = []
    for name, solid in assembly(0) + iris.hardware(0):
        if name in ('lid', 'funnel') or name.endswith(' lid'):
            continue
        color = BLADES[int(name.split()[1]) - 1] if name.startswith('blade') else iris.color_of(name)
        tri, col = meshes([(name, solid, color)], light, max_edge=5.0)
        if name in pivots:
            axis, turn = pivots[name][:2], lambda a: a
        elif name == 'ring':
            axis, turn = (0.0, 0.0), lambda a: iris.K_RING * a
        elif name in ('pinion', 'motor shaft', 'grub screw M3x6'):
            axis, turn = motor_axis, lambda a: -iris.motor_turn(a)
        else:
            axis, turn = None, None
        moving.append((tri, col, axis, turn))

    def turned(tri, axis, deg):
        c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        out = tri.copy()
        x, y = tri[..., 0] - axis[0], tri[..., 1] - axis[1]
        out[..., 0], out[..., 1] = axis[0] + c * x - s * y, axis[1] + s * x + c * y
        return out

    fig = plt.figure(figsize=(11, 5.6), facecolor=PAPER)
    ax3 = fig.add_subplot(1, 2, 1, projection='3d')
    ax2 = fig.add_subplot(1, 2, 2)
    stroke = [iris.ALPHA_MAX * (1 - math.cos(math.pi * 2 * k / frames)) / 2 for k in range(frames)]

    def draw(k):
        alpha = stroke[k]
        ax3.clear()
        ax3.set_facecolor(PAPER)
        tris, cols = [], []
        for tri, col, axis, turn in moving:
            tris.append(turned(tri, axis, turn(alpha)) if axis else tri)
            cols.append(col)
        cols = np.concatenate(cols)
        ax3.add_collection3d(Poly3DCollection(np.concatenate(tris), facecolors=cols, edgecolors=cols, linewidths=0.3))
        ax3.set_xlim(-70, 95)
        ax3.set_ylim(-80, 80)
        ax3.set_zlim(-60, 40)
        ax3.set_box_aspect((165, 160, 100), zoom=1.3)
        ax3.view_init(elev=38, azim=-62)
        ax3.axis('off')
        ax3.set_title('lid and funnel off', color=INK, fontsize=11, weight='bold')

        ax2.clear()
        ax2.set_facecolor(PAPER)
        ax2.add_patch(plt.Circle((0, 0), iris.R_LEDGE, color='#1a0f0a', zorder=0))
        for i in range(iris.N):
            x, y = blade(i, alpha).exterior.xy
            ax2.fill(x, y, color=BLADES[i], alpha=0.92, ec=INK, lw=1.2, zorder=2 + 10 * (i % 2) + i)
            dx, dy = iris.rot(iris.drive_pin(alpha), 360 * i / iris.N)
            ax2.add_patch(plt.Circle((dx, dy), iris.DRIVE_PIN_D / 2, color=INK, zorder=30))
        ax2.add_patch(plt.Circle((0, 0), iris.R_AP, fill=False, ls='--', ec=PAPER, lw=1, zorder=40))
        L = iris.loads(alpha, 0.3)
        steps = iris.motor_turn(alpha) / 1.8 * 16
        ax2.set_title(f'opening {opening(alpha):4.1f} mm  ·  {steps:4.0f} microsteps', color=INK, fontsize=11, weight='bold')
        ax2.text(0, -52, f'at 0.3 A, one blade jammed: drive pin {L["drive pin"]:4.1f} MPa, squeeze {L["squeeze"]:3.0f} N',
                 ha='center', color=INK, fontsize=9)
        ax2.set_xlim(-50, 50)
        ax2.set_ylim(-56, 50)
        ax2.set_aspect('equal')
        ax2.axis('off')

    fig.subplots_adjust(left=0, right=0.98, top=0.92, bottom=0.02, wspace=0.02)
    FuncAnimation(fig, draw, frames=frames).save(path, writer=PillowWriter(fps=12), dpi=80, savefig_kwargs={'facecolor': PAPER})
    plt.close(fig)


if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'images'), exist_ok=True)
    top_views(os.path.join(HERE, 'images', 'iris-top.png'))
    exploded(os.path.join(HERE, 'images', 'iris-exploded.png'))
    assembled(os.path.join(HERE, 'images', 'iris-assembly.png'))
    levels(os.path.join(HERE, 'images', 'iris-levels.png'))
    stress_profile(os.path.join(HERE, 'images', 'iris-stress.png'))
    animation(os.path.join(HERE, 'images', 'iris-motion.gif'))
    print('images/iris-top.png, iris-exploded.png, iris-assembly.png, iris-levels.png, iris-stress.png, iris-motion.gif')
