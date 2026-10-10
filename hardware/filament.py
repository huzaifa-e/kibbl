"""
Filament estimate of STL files, sliced the way the Bambu Lab A1 "0.20mm Standard" profile does:
0.2 mm layers, 2 wall loops of 0.42 mm, 5 top and 3 bottom solid layers, 15 % sparse infill,
Bambu PLA Basic (1.26 g/cm3, 24.99 a kg). A slicer differs by a few percent (seams, gap fill,
infill overlap); good enough to compare designs.

    python filament.py feeder/assembly/stl/*.stl
"""
import argparse
import os

import numpy as np
import trimesh
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

LAYER = 0.2
LINE = 0.42
WALLS = 2
TOP, BOTTOM = 5, 3
INFILL = 0.15
DENSITY = 1.26  # g/cm3
PRICE = 24.99  # a kg


def layers(mesh):
    z0, z1 = mesh.bounds[:, 2]
    heights = np.arange(z0 + LAYER / 2, z1, LAYER)
    sections = mesh.section_multiplane(plane_origin=[0, 0, 0], plane_normal=[0, 0, 1], heights=heights)
    out = []
    for s in sections:
        if s is None:
            out.append(Polygon())
            continue
        polys = [p.buffer(0) for p in s.polygons_full]
        out.append(unary_union(polys) if polys else Polygon())
    return out


def estimate(path):
    """mm3 of plastic: walls, solid skin, sparse infill."""
    mesh = trimesh.load(path)
    regions = layers(mesh)
    wall_t = WALLS * LINE
    walls = solid = sparse = 0.0
    n = len(regions)
    for i, r in enumerate(regions):
        if r.is_empty:
            continue
        inner = r.buffer(-wall_t)
        walls += r.area - inner.area
        if inner.is_empty:
            continue
        # covered above for TOP layers and below for BOTTOM layers: the rest is skin
        covered = inner
        for k in list(range(1, TOP + 1)) + [-k for k in range(1, BOTTOM + 1)]:
            j = i + k
            covered = covered.intersection(regions[j]) if 0 <= j < n else Polygon()
            if covered.is_empty:
                break
        # strips too narrow for infill lines are gap-filled solid
        wide = covered.buffer(-1.0).buffer(1.0).intersection(covered)
        solid += inner.area - wide.area
        sparse += wide.area
    return LAYER * walls, LAYER * solid, LAYER * sparse * INFILL


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('stl', nargs='+')
    args = parser.parse_args()
    total = 0.0
    print(f'{"part":<16}{"walls":>8}{"skin":>8}{"infill":>8}{"g":>8}{"cost":>8}')
    for path in args.stl:
        w, s, f = estimate(path)
        g = (w + s + f) / 1000 * DENSITY
        total += g
        print(f'{os.path.splitext(os.path.basename(path))[0]:<16}{w / 1000 * DENSITY:>8.0f}{s / 1000 * DENSITY:>8.0f}{f / 1000 * DENSITY:>8.0f}'
              f'{g:>8.0f}{g / 1000 * PRICE:>8.2f}')
    print(f'{"total":<16}{"":>24}{total:>8.0f}{total / 1000 * PRICE:>8.2f}')


if __name__ == '__main__':
    main()
