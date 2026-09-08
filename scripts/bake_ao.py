"""Bake whole-plant ambient occlusion into per-vertex tint colors.

Usage: .venv-bpy/bin/python scripts/bake_ao.py SRC_DIR DST_DIR

Builds one BVH over every organ of the stage (assembled pose), then for each
vertex casts a small cosine-weighted ray fan along its normal and darkens the
vertex tint by local occlusion. Contact regions - culms inside sheaths, the
canopy interior, the crown, the root-mass core - gain soft baked shading that
survives into both the live renderer and photo mode.
"""
import math
import os
import random
import sys

import bpy  # noqa: F401  (loads the bundled mathutils)
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
src, dst = argv[0], argv[1]
os.makedirs(dst, exist_ok=True)

MAX_DIST = 60.0      # mm; occlusion is local contact shading, not global gloom
STRENGTH = 0.62
FLOOR = 0.34
RAYS = 10
EPS = 0.5            # push ray origins off the surface

# ---------------------------------------------------------------- load stage
files = sorted(n for n in os.listdir(src) if n.endswith('.obj'))
all_verts, all_tris = [], []
organs = []          # (name, lines, v_indices(base offset), vi->ni map, vn list)
for name in files:
    lines = open(os.path.join(src, name)).read().splitlines()
    base = len(all_verts)
    vns, vi_ni = [], {}
    n_verts = 0
    for line in lines:
        if line.startswith('v '):
            f = line.split()
            all_verts.append(Vector((float(f[1]), float(f[2]), float(f[3]))))
            n_verts += 1
        elif line.startswith('vn '):
            f = line.split()
            vns.append(Vector((float(f[1]), float(f[2]), float(f[3]))))
        elif line.startswith('f '):
            corners = []
            for token in line.split()[1:]:
                comp = token.split('/')
                vi = int(comp[0])-1
                if len(comp) > 2 and comp[2] and vi not in vi_ni:
                    vi_ni[vi] = int(comp[2])-1
                corners.append(vi)
            for j in range(1, len(corners)-1):
                all_tris.append((base+corners[0], base+corners[j], base+corners[j+1]))
    organs.append((name, lines, base, n_verts, vi_ni, vns))

print(f'bake_ao: {len(all_verts)} vertices, {len(all_tris)} triangles; building BVH...')
bvh = BVHTree.FromPolygons([tuple(v) for v in all_verts], all_tris, epsilon=0.0)

# precomputed cosine-weighted hemisphere fan (local frame: +Z is the normal)
random.seed(11)
FAN = []
for i in range(RAYS):
    u1, u2 = (i+0.5)/RAYS, (i*0.618034) % 1.0
    r = math.sqrt(u1)
    th = 2*math.pi*u2
    FAN.append(Vector((r*math.cos(th), r*math.sin(th), math.sqrt(max(0.0, 1.0-u1)))))

def occlusion(p, n, salt):
    # build a tangent frame around the normal
    a = Vector((0, 1, 0)) if abs(n.z) > 0.9 else Vector((0, 0, 1))
    t = n.cross(a).normalized()
    b = n.cross(t)
    rot = (salt*2.399963) % (2*math.pi)
    ct, st = math.cos(rot), math.sin(rot)
    o = p + n*EPS
    occ = 0.0
    for d in FAN:
        dx, dy = d.x*ct - d.y*st, d.x*st + d.y*ct
        ray = (t*dx + b*dy + n*d.z)
        hit = bvh.ray_cast(o, ray, MAX_DIST)
        if hit[0] is not None:
            occ += 1.0 - hit[3]/MAX_DIST
    return max(FLOOR, 1.0 - STRENGTH*occ/RAYS)

# ------------------------------------------------------------------- rewrite
done = 0
for name, lines, base, n_verts, vi_ni, vns in organs:
    out, vi = [], 0
    for line in lines:
        if line.startswith('v '):
            f = line.split()
            p = all_verts[base+vi]
            ni = vi_ni.get(vi)
            n = vns[ni] if ni is not None and ni < len(vns) else Vector((0, 1, 0))
            ao = occlusion(p, n, base+vi)
            r, g, b = (float(f[4]), float(f[5]), float(f[6])) if len(f) >= 7 else (1, 1, 1)
            out.append(f'v {f[1]} {f[2]} {f[3]} {r*ao:.3f} {g*ao:.3f} {b*ao:.3f}')
            vi += 1
        else:
            out.append(line)
    open(os.path.join(dst, name), 'w').write('\n'.join(out)+'\n')
    done += 1
    if done % 100 == 0:
        print(f'bake_ao: {done}/{len(organs)} organs')
print(f'bake_ao: baked {len(all_verts)} vertices across {done} organs -> {dst}')
