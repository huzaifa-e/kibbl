"""
Pictures for the README: the case from the front and from the back, and the
clip-ons. Needs matplotlib and trimesh next to build123d.

    python render.py
"""
import os
import tempfile

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

import case

HERE = os.path.dirname(os.path.abspath(__file__))
PAPER = '#f3e6cf'
COLORS = {
    'case_front': '#c9b18f',
    'case_back': '#a8916f',
    'case_label': '#d9622b',
    'clip_shelf': '#d9622b',
    'clip_strap': '#7f9a2e',
    'clip_tripod': '#3d7a73',
}


def meshes(solids):
    import trimesh
    from build123d import export_stl

    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (solid, color) in enumerate(solids):
            f = os.path.join(tmp, f'{i}.stl')
            export_stl(solid, f, tolerance=0.05, angular_tolerance=0.2)
            out.append((trimesh.load(f), color))
    return out


def draw(ax, items, elev, azim, light=(0.3, -0.6, 0.75)):
    light = np.array(light) / np.linalg.norm(light)
    tris, cols = [], []
    for mesh, color in items:
        shade = 0.35 + 0.65 * np.clip(mesh.face_normals @ light, 0, 1)
        rgb = np.array(matplotlib.colors.to_rgb(color))
        tris.append(mesh.triangles)
        cols.append(np.clip(rgb[None, :] * shade[:, None] + 0.08, 0, 1))
    # one collection: matplotlib orders faces by depth within a collection only
    ax.add_collection3d(Poly3DCollection(np.concatenate(tris), facecolors=np.concatenate(cols), edgecolors='none'))
    allpts = np.concatenate([m.vertices for m, _ in items])
    lo, hi = allpts.min(axis=0), allpts.max(axis=0)
    c, r = (lo + hi) / 2, (hi - lo).max() / 2 * 0.85
    ax.set_xlim(c[0] - r, c[0] + r)
    ax.set_ylim(c[1] - r, c[1] + r)
    ax.set_zlim(c[2] - r, c[2] + r)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=elev, azim=azim)
    ax.axis('off')
    ax.set_facecolor(PAPER)


def main():
    from build123d import Pos

    parts = case.build_parts()
    # shown hanging: USB-C down. The model's x runs down the case, z towards the back.
    body = meshes([(parts['case_front'], COLORS['case_front']), (parts['case_back'], COLORS['case_back']),
                   (parts['case_label'], COLORS['case_label'])])

    def hang(items):
        # (x, y, z) -> (-y, z, -x), a rotation (no mirror): up is -x, the front faces -y
        out = []
        for m, c in items:
            m = m.copy()
            v = m.vertices.copy()
            m.vertices = np.column_stack([-v[:, 1], v[:, 2], -v[:, 0]])
            out.append((m, c))
        return out

    fig = plt.figure(figsize=(12, 5.2), facecolor=PAPER)
    ax1 = fig.add_subplot(1, 3, 1, projection='3d')
    draw(ax1, hang(body), elev=12, azim=-62)
    ax1.set_title('front: lens, flash, USB-C', color='#2a1a12', fontsize=10, weight='bold')
    ax2 = fig.add_subplot(1, 3, 2, projection='3d')
    draw(ax2, hang(body), elev=12, azim=110, light=(-0.3, 0.6, 0.75))
    ax2.set_title('back: kibbl., keyhole for a nail', color='#2a1a12', fontsize=10, weight='bold')

    clips = []
    for i, name in enumerate(('clip_shelf', 'clip_strap', 'clip_tripod')):
        clips.append((Pos(0, 0, 0) * parts[name], COLORS[name]))
    clip_meshes = meshes(clips)
    # side by side across the plot
    laid = []
    for i, (m, c) in enumerate(clip_meshes):
        m = m.copy()
        m.vertices = m.vertices + np.array([0, i * 42.0, 0])
        laid.append((m, c))
    laid += [(m, c) for m, c in body]
    ax3 = fig.add_subplot(1, 3, 3, projection='3d')
    draw(ax3, hang(laid), elev=18, azim=125, light=(-0.3, 0.6, 0.75))
    ax3.set_title('clip-ons: shelf, strap, tripod', color='#2a1a12', fontsize=10, weight='bold')

    fig.tight_layout()
    os.makedirs(os.path.join(HERE, 'images'), exist_ok=True)
    fig.savefig(os.path.join(HERE, 'images', 'case.png'), dpi=120, facecolor=PAPER)
    print('images/case.png')


if __name__ == '__main__':
    main()
