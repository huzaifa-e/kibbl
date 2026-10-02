"""
Pictures for the README: the iris from above at three openings, and the parts
exploded. Needs matplotlib, shapely and trimesh next to build123d.

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
            ax.fill(x, y, color=BLADES[i], alpha=0.92, ec=INK, lw=1.4, zorder=2 + i)
            px, py = iris.polar(iris.RP, 360 * i / iris.N)
            dx, dy = iris.rot(iris.drive_pin(alpha), 360 * i / iris.N)
            ax.add_patch(plt.Circle((px, py), iris.PIVOT_PIN_D / 2, color=PAPER, ec=INK, zorder=20))
            ax.add_patch(plt.Circle((dx, dy), iris.DRIVE_PIN_D / 2, color=INK, zorder=20))
        free = aperture.difference(unary_union(blades)).area
        ax.add_patch(plt.Circle((0, 0), iris.R_AP, fill=False, ls='--', ec=PAPER, lw=1, zorder=30))
        ax.set_title(f'swing {alpha:.1f}°  ·  opening {2 * math.sqrt(free / math.pi):.0f} mm', color=INK, fontsize=11, weight='bold')
        ax.set_xlim(-50, 50)
        ax.set_ylim(-50, 50)
        ax.set_aspect('equal')
        ax.axis('off')
    fig.tight_layout()
    fig.savefig(path, dpi=130, facecolor=PAPER)
    plt.close(fig)


def exploded(path):
    from build123d import Pos, Rot, export_stl
    import trimesh

    parts, _ = iris.build_parts()
    rp = iris.RP
    lift = {'base': 0, 'blades': 26, 'ring': 62, 'pinion': 62, 'lid': 96, 'funnel': 126}
    placed = [
        ('base', parts['base'], '#8b5a3c'),
        ('ring', Pos(0, 0, iris.Z_RING + lift['ring']) * parts['ring'], '#e0a526'),
        ('pinion', Pos(iris.CENTER_DIST, 0, iris.Z_RING + lift['pinion']) * parts['pinion'], '#7f9a2e'),
        ('lid', Pos(0, 0, lift['lid']) * parts['lid'], '#c9b18f'),
        ('funnel', Pos(0, 0, lift['funnel']) * parts['funnel'], '#d9622b'),
    ]
    for i in range(iris.N):
        b = Rot(0, 0, 360 * i / iris.N) * Pos(rp, 0, iris.Z_BLADES + lift['blades']) * Pos(-rp, 0, 0) * parts['blade']
        placed.append((f'blade{i}', b, BLADES[i]))

    fig = plt.figure(figsize=(8, 9), facecolor=PAPER)
    ax = fig.add_subplot(projection='3d')
    ax.set_facecolor(PAPER)
    light = np.array([0.4, -0.5, 0.8])
    light /= np.linalg.norm(light)
    # one collection for all parts: matplotlib orders faces by depth within a collection only
    triangles, colors = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for name, solid, color in placed:
            f = os.path.join(tmp, f'{name}.stl')
            export_stl(solid, f, tolerance=0.1, angular_tolerance=0.3)
            mesh = trimesh.load(f)
            shade = 0.45 + 0.55 * np.clip(mesh.face_normals @ light, 0, 1)
            rgb = np.array(matplotlib.colors.to_rgb(color))
            triangles.append(mesh.triangles)
            colors.append(np.clip(rgb[None, :] * shade[:, None], 0, 1))
    ax.add_collection3d(Poly3DCollection(np.concatenate(triangles), facecolors=np.concatenate(colors), edgecolors='none'))
    ax.set_xlim(-70, 95)
    ax.set_ylim(-80, 80)
    ax.set_zlim(-30, 200)
    ax.set_box_aspect((165, 160, 230))
    ax.view_init(elev=24, azim=-58)
    ax.axis('off')
    fig.tight_layout()
    fig.savefig(path, dpi=110, facecolor=PAPER)
    plt.close(fig)


if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'images'), exist_ok=True)
    top_views(os.path.join(HERE, 'images', 'iris-top.png'))
    exploded(os.path.join(HERE, 'images', 'iris-exploded.png'))
    print('images/iris-top.png, images/iris-exploded.png')
