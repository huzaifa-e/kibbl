"""
Pictures for the README: the feeder outside and cut through the chute, the electronics bay
from behind, the parts exploded, and what the camera sees of the bowl. Needs matplotlib and
trimesh next to build123d.

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


if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'images'), exist_ok=True)
    camera_view(os.path.join(HERE, 'images', 'camera-view.png'))
    outside_and_cut(os.path.join(HERE, 'images', 'feeder.png'))
    bay(os.path.join(HERE, 'images', 'bay.png'))
    exploded(os.path.join(HERE, 'images', 'exploded.png'))
