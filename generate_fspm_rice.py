"""Procedural functional-structural model of a rice plant (Oryza sativa).

Generates four growth stages (seedling, tillering, heading, maturity). For each
stage, one OBJ per selectable organ is written into rice_obj_<stage>/ along with
concept_map_<stage>.json and system_map_<stage>.json for scripts/convert-anatomy.py.
Units are millimeters, Y-up; the converter scales to meters. Each plant stands
with its root tips near y=0 so the specimen rests on the studio platform.
"""
import os
import json
import math
import random
import shutil
import colorsys

# ---------------------------------------------------------------- color math
def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16)/255 for i in (0, 2, 4))

def rgb_to_hex(r, g, b):
    return '#%02x%02x%02x' % tuple(max(0, min(255, round(c*255))) for c in (r, g, b))

def mix_hex(a, b, t):
    ra, ga, ba = hex_to_rgb(a)
    rb, gb, bb = hex_to_rgb(b)
    return rgb_to_hex(ra+(rb-ra)*t, ga+(gb-ga)*t, ba+(bb-ba)*t)

def vary(h, dl=0.04, dh=0.008, ds=0.05):
    """Jitter a hex color slightly in hue, lightness, and saturation."""
    hh, l, s = colorsys.rgb_to_hls(*hex_to_rgb(h))
    hh = (hh + random.uniform(-dh, dh)) % 1
    l = max(0, min(1, l + random.uniform(-dl, dl)))
    s = max(0, min(1, s + random.uniform(-ds, ds)))
    return rgb_to_hex(*colorsys.hls_to_rgb(hh, l, s))

# ---------------------------------------------------------------- vector math
def v_add(a, b): return (a[0]+b[0], a[1]+b[1], a[2]+b[2])
def v_sub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def v_scale(a, s): return (a[0]*s, a[1]*s, a[2]*s)
def v_dot(a, b): return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
def v_cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def v_len(a): return math.sqrt(v_dot(a, a))
def v_norm(a):
    l = v_len(a)
    return (0.0, 1.0, 0.0) if l < 1e-9 else v_scale(a, 1.0/l)

def rotate_about(v, axis, angle):
    """Rodrigues rotation of v about unit axis."""
    c, s = math.cos(angle), math.sin(angle)
    return v_add(v_add(v_scale(v, c), v_scale(v_cross(axis, v), s)),
                 v_scale(axis, v_dot(axis, v)*(1-c)))

def catmull_rom(points, subdivisions=4):
    """Smooth a polyline with Catmull-Rom interpolation."""
    if len(points) < 3 or subdivisions <= 1:
        return list(points)
    pts = [points[0]] + list(points) + [points[-1]]
    out = []
    for i in range(len(pts)-3):
        p0, p1, p2, p3 = pts[i], pts[i+1], pts[i+2], pts[i+3]
        for j in range(subdivisions):
            t = j/subdivisions
            t2, t3 = t*t, t*t*t
            out.append(tuple(
                0.5*((2*p1[k]) + (-p0[k]+p2[k])*t + (2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2
                     + (-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t3) for k in range(3)))
    out.append(points[-1])
    return out

def transport_frames(points):
    """Parallel-transport frames along a polyline: (tangent, normal, binormal)."""
    tangents = []
    for i in range(len(points)):
        if i == 0:
            t = v_sub(points[1], points[0])
        elif i == len(points)-1:
            t = v_sub(points[-1], points[-2])
        else:
            t = v_sub(points[i+1], points[i-1])
        tangents.append(v_norm(t))
    up = (0.0, 1.0, 0.0) if abs(tangents[0][1]) < 0.95 else (1.0, 0.0, 0.0)
    n = v_norm(v_cross(tangents[0], up))
    frames = []
    for i, t in enumerate(tangents):
        if i > 0:
            axis = v_cross(tangents[i-1], t)
            l = v_len(axis)
            if l > 1e-9:
                n = rotate_about(n, v_scale(axis, 1.0/l), math.asin(min(1.0, l)))
        n = v_norm(v_sub(n, v_scale(t, v_dot(n, t))))
        frames.append((t, n, v_norm(v_cross(t, n))))
    return frames

# ------------------------------------------------------------- mesh building
# Meshes are (vertices, faces, tints, uvs) tuples. A tint is a per-vertex RGB
# multiplier in [0, 2] applied on top of the organ color in the shader; uvs
# map the detail textures (striations, veins, papillae).
WHITE = (1.0, 1.0, 1.0)

def tube(points, radii, segments=10, cap_start=False, cap_end=True, tint_fn=None, v_scale_mm=30.0):
    """Sweep a circle of per-point radius along a polyline. Outward winding.

    Rings carry segments+1 columns so the texture seam is clean; v advances
    with real arc length so striations don't stretch.
    """
    frames = transport_frames(points)
    verts, faces, tints, uvs = [], [], [], []
    n_rings = len(points)
    cols = segments+1
    arc = 0.0
    for i, p in enumerate(points):
        _, n, b = frames[i]
        if i > 0:
            arc += v_len(v_sub(points[i], points[i-1]))
        r = radii[i] if isinstance(radii, (list, tuple)) else radii
        t = tint_fn(i, n_rings) if tint_fn else WHITE
        vv = arc/v_scale_mm
        for s in range(cols):
            a = 2*math.pi*s/segments
            verts.append(v_add(p, v_add(v_scale(n, r*math.cos(a)), v_scale(b, r*math.sin(a)))))
            tints.append(t)
            uvs.append((s/segments, vv))
    for i in range(len(points)-1):
        for s in range(segments):
            p1, p2 = i*cols+s, i*cols+s+1
            p3, p4 = (i+1)*cols+s, (i+1)*cols+s+1
            faces.append((p1, p3, p2))
            faces.append((p2, p3, p4))
    if cap_start:
        c = len(verts); verts.append(points[0]); tints.append(tint_fn(0, n_rings) if tint_fn else WHITE); uvs.append((0.5, 0.0))
        for s in range(segments):
            faces.append((c, s, s+1))
    if cap_end:
        c = len(verts); verts.append(points[-1]); tints.append(tint_fn(n_rings-1, n_rings) if tint_fn else WHITE); uvs.append((0.5, arc/v_scale_mm))
        base = (len(points)-1)*cols
        for s in range(segments):
            faces.append((c, base+s+1, base+s))
    return verts, faces, tints, uvs

def grain_frame(axis, side_hint):
    a = v_norm(axis)
    s1 = v_norm(v_cross(a, side_hint if abs(v_dot(v_norm(side_hint), a)) < 0.9 else (0, 1, 0)))
    s2 = v_norm(v_cross(a, s1))
    return a, s1, s2

def grain_mesh(center, axis, side_hint, length=8.4, width=3.6, thickness=2.5, lat=6, lon=10,
               tint=WHITE, ridges=0.05):
    """A husked rice grain: a gently pointed ellipsoid with longitudinal lemma ridges."""
    a, s1, s2 = grain_frame(axis, side_hint)
    verts, faces = [], []
    for i in range(lat+1):
        phi = math.pi*i/lat
        y = math.cos(phi)
        r = math.sin(phi)**0.86  # pointed at the apiculus and base
        for j in range(lon):
            th = 2*math.pi*j/lon
            rs = 1 + ridges*math.cos(5*th)  # five ridges of the lemma and palea
            p = v_add(v_scale(a, y*length/2),
                      v_add(v_scale(s1, r*math.cos(th)*width/2*rs),
                            v_scale(s2, r*math.sin(th)*thickness/2*rs)))
            verts.append(v_add(center, p))
    for i in range(lat):
        for j in range(lon):
            nj = (j+1) % lon
            p1, p2 = i*lon+j, i*lon+nj
            p3, p4 = (i+1)*lon+j, (i+1)*lon+nj
            faces.append((p1, p2, p3))
            faces.append((p2, p4, p3))
    uvs = [(j/lon, i/lat) for i in range(lat+1) for j in range(lon)]
    return verts, faces, [tint]*len(verts), uvs

def half_grain_mesh(center, a, s1, s2, length, width, thickness, lat=10, lon=7, cap=False):
    """Half a grain ellipsoid, cut along the plane spanned by axis and s1.

    The surface occupies the +s2 side. With cap=True the flat cut face is filled,
    giving a solid-looking half (for the endosperm); without it the half is an
    open shell (for the husk).
    """
    verts, faces = [], []
    for i in range(lat+1):
        phi = math.pi*i/lat
        y = math.cos(phi)
        r = math.sin(phi)**0.92
        for j in range(lon+1):
            th = math.pi*j/lon
            p = v_add(v_scale(a, y*length/2),
                      v_add(v_scale(s1, r*math.cos(th)*width/2),
                            v_scale(s2, r*math.sin(th)*thickness/2)))
            verts.append(v_add(center, p))
    cols = lon+1
    for i in range(lat):
        for j in range(lon):
            p1, p2 = i*cols+j, i*cols+j+1
            p3, p4 = (i+1)*cols+j, (i+1)*cols+j+1
            faces.append((p1, p2, p3))
            faces.append((p2, p4, p3))
    if cap:
        # fill the flat ellipse between the two boundary meridians (j=0 and j=lon)
        for i in range(lat):
            a1, a2 = i*cols, (i+1)*cols
            b1, b2 = i*cols+lon, (i+1)*cols+lon
            faces.append((a1, a2, b1))
            faces.append((a2, b2, b1))
    uvs = [(j/lon, i/lat) for i in range(lat+1) for j in range(lon+1)]
    return verts, faces, [WHITE]*len(verts), uvs

def merge(meshes):
    verts, faces, tints, uvs = [], [], [], []
    for mv, mf, mt, mu in meshes:
        base = len(verts)
        verts.extend(mv)
        tints.extend(mt)
        uvs.extend(mu)
        faces.extend(tuple(i+base for i in f) for f in mf)
    return verts, faces, tints, uvs

def polyline_length(points):
    return sum(v_len(v_sub(points[i+1], points[i])) for i in range(len(points)-1))

def write_obj(filename, vertices, faces, tints=None, uvs=None):
    with open(os.path.join(OUT_DIR, filename), "w") as f:
        for i, v in enumerate(vertices):
            t = tints[i] if tints else WHITE
            f.write(f"v {v[0]:.3f} {v[1]:.3f} {v[2]:.3f} {t[0]:.3f} {t[1]:.3f} {t[2]:.3f}\n")
        for i in range(len(vertices)):
            u, vv = uvs[i] if uvs else (0.0, 0.0)
            f.write(f"vt {u:.4f} {vv:.4f}\n")
        normals = [(0.0, 0.0, 0.0)]*len(vertices)
        for face in faces:
            i1, i2, i3 = face
            v1, v2, v3 = vertices[i1], vertices[i2], vertices[i3]
            n = v_cross(v_sub(v2, v1), v_sub(v3, v1))
            for idx in face:
                normals[idx] = v_add(normals[idx], n)
        for n in normals:
            l = v_len(n)
            if l < 1e-12:
                f.write("vn 0 1 0\n")
            else:
                f.write(f"vn {n[0]/l:.4f} {n[1]/l:.4f} {n[2]/l:.4f}\n")
        for face in faces:
            f.write("f " + " ".join(f"{i+1}/{i+1}/{i+1}" for i in face) + "\n")

# ------------------------------------------------------------- stage configs
GOLDEN = math.radians(137.507764)

STAGES = {
 "seedling": dict(
    crown_y=110, tillers=1, roots=14, root_steps=(12, 20), root_nsteps=6, root_r=0.9,
    leaf_ranks=[(95, 4.5, 62, 55), (140, 5.5, 66, 48), (185, 6.5, 70, 42), (215, 7.0, 74, 36)],
    internode_fracs=(0.22, 0.25, 0.26, 0.27), r0=2.2, r_step=0.28,
    height_main=(55, 70), height_tiller=(55, 70), sheath_extra=0.7,
    blade_colors=['#5d9540', '#55913a', '#4e8d35', '#488a31'],
    sheath_colors=['#699b46', '#619842', '#59943f', '#52913c'],
    internode_colors=['#7fa452', '#78a14e', '#719e4a', '#6b9b47'],
    crown_color='#84a050', root_color='#b39871',
    panicle=None, flag=False, cutaway=False, ligule_h=2.0,
    senescence=[0.0, 0.0, 0.0, 0.0], seed_husk=True,
 ),
 "tillering": dict(
    crown_y=230, tillers=5, late_tillers=1, roots=30, root_steps=(20, 30), root_nsteps=8, root_r=1.3,
    leaf_ranks=[(180, 7.5, 55, 100), (240, 9.0, 57, 92), (300, 10.5, 60, 84),
                (350, 11.5, 62, 76), (385, 12.5, 66, 62), (360, 12.0, 70, 50)],
    internode_fracs=(0.06, 0.09, 0.13, 0.18, 0.25, 0.29), r0=4.0, r_step=0.42,
    height_main=(290, 340), height_tiller=(250, 310), sheath_extra=1.0,
    blade_colors=['#6f9c45', '#659740', '#5b923a', '#529036', '#4a8a32', '#458730'],
    sheath_colors=['#78a04b', '#6f9c48', '#659947', '#5c9544', '#549241', '#4e9040'],
    internode_colors=['#93aa55', '#8aa851', '#82a64e', '#79a34b', '#71a048', '#699e46'],
    crown_color='#8ba64f', root_color='#af9168',
    panicle=None, flag=False, cutaway=False, ligule_h=3.0,
    senescence=[0.5, 0.25, 0.1, 0.0, 0.0, 0.0],
 ),
 "heading": dict(
    crown_y=330, tillers=8, late_tillers=2, roots=44, root_steps=(26, 40), root_nsteps=9, root_r=1.55,
    leaf_ranks=[(200, 7.0, 48, 130), (290, 9.0, 50, 122), (380, 11.0, 53, 114),
                (460, 13.0, 55, 106), (530, 15.0, 57, 98), (555, 16.5, 59, 90),
                (480, 15.5, 64, 70), (375, 14.0, 76, 44)],
    internode_fracs=(0.02, 0.03, 0.04, 0.06, 0.10, 0.17, 0.26, 0.32), r0=5.6, r_step=0.42,
    height_main=(1060, 1120), height_tiller=(900, 1060), sheath_extra=1.25,
    blade_colors=['#7d9a49', '#719743', '#65943e', '#5a903a', '#508c36', '#488832', '#428430', '#3d812d'],
    sheath_colors=['#849d4d', '#7a9b49', '#709846', '#679544', '#5e9241', '#568f3f', '#508c3d', '#4b8a3b'],
    internode_colors=['#a2a95a', '#9aa756', '#92a552', '#8aa24f', '#82a04c', '#7a9d49', '#729a47', '#6b9845'],
    crown_color='#8ea653', root_color='#ab8a60',
    panicle=dict(theta_end=(58, 84), droop=(0.35, 0.65), blen=(65, 88), rachis=(185, 215),
                 grain_len=(7.2, 8.2), grain_w=(3.0, 3.4), grain_t=(2.0, 2.4), awn=(9, 17),
                 ripeness=(0.0, 0.45), axis_a='#87a04a', axis_b='#96a04a',
                 grain_a='#9db35c', grain_b='#b3a94e'),
    flag=True, cutaway=False, ligule_h=4.0,
    senescence=[0.95, 0.75, 0.5, 0.3, 0.16, 0.08, 0.03, 0.01],
 ),
 "maturity": dict(
    crown_y=330, tillers=8, late_tillers=2, roots=44, root_steps=(26, 40), root_nsteps=9, root_r=1.55,
    leaf_ranks=[(200, 7.0, 48, 155), (290, 9.0, 50, 145), (380, 11.0, 53, 132),
                (460, 13.0, 55, 118), (530, 15.0, 57, 104), (555, 16.5, 59, 92),
                (480, 15.5, 64, 72), (375, 14.0, 74, 50)],
    internode_fracs=(0.02, 0.03, 0.04, 0.06, 0.10, 0.17, 0.26, 0.32), r0=5.6, r_step=0.42,
    height_main=(1120, 1180), height_tiller=(960, 1120), sheath_extra=1.25,
    blade_colors=['#9a9a4e', '#8d974a', '#7f9545', '#6f9440', '#60903b', '#548b36', '#4b8532', '#457f2e'],
    sheath_colors=['#a3a253', '#999f4e', '#8d9c4a', '#809846', '#729443', '#659040', '#5d8d3e', '#588b3c'],
    internode_colors=['#b8ac60', '#b1aa5c', '#a9a858', '#a0a654', '#96a450', '#8ca14d', '#829e4a', '#789b48'],
    crown_color='#9aa455', root_color='#ab8a60',
    panicle=dict(theta_end=(142, 162), droop=(0.9, 1.4), blen=(70, 95), rachis=(200, 230),
                 grain_len=(8.6, 9.6), grain_w=(3.6, 4.1), grain_t=(2.4, 2.8), awn=(11, 22),
                 ripeness=(0.15, 1.0), axis_a='#9aa14f', axis_b='#a68c3c',
                 grain_a='#c2b158', grain_b='#d69c2c'),
    flag=True, cutaway=True, ligule_h=4.0,
    senescence=[1.0, 0.92, 0.78, 0.58, 0.38, 0.22, 0.1, 0.04], dead_leaves=True,
 ),
}

# ------------------------------------------------------------------ registry
OUT_DIR = ""
elements, system_map, concept_members, counter = [], {}, {}, {}

def add_part(prefix, name, concept_id, system, mesh, extra_concepts=(), color=None, stats=None,
             growth=None, color0=None, ctrans=None):
    counter[prefix] = counter.get(prefix, 0) + 1
    pid = f"{prefix}_{counter[prefix]:04d}"
    verts, faces, tints, uvs = mesh
    write_obj(f"{pid}.obj", verts, faces, tints, uvs)
    element = {"id": pid, "name": name, "conceptId": concept_id}
    if color:
        element["color"] = color
    if stats:
        element["stats"] = stats
    if growth:
        element["growth"] = {"birth": round(growth["birth"], 1), "dur": round(growth["dur"], 1),
                             "anchor": [round(v, 2) for v in growth["anchor"]],
                             "culm": growth.get("culm", -1), "node": growth.get("node", -1)}
    if color0:
        element["color0"] = color0
    if ctrans:
        element["cbirth"], element["cdur"] = round(ctrans[0], 1), round(ctrans[1], 1)
    elements.append(element)
    system_map[pid] = system
    for cid in (concept_id, *extra_concepts):
        concept_members.setdefault(cid, []).append(pid)
    return pid

# ------------------------------------------------------------------ builders
def culm_line(base, azimuth, lean_deg, height, bow, node_heights=()):
    """Return a culm centerline as a function of height h in [0, height].

    Real culms bend a degree or two at each solid node rather than curving
    smoothly; node_heights adds a small random lateral kink above each joint.
    """
    lean = math.radians(lean_deg)
    ax, az_ = math.cos(azimuth), math.sin(azimuth)
    kinks = [(random.uniform(-2.6, 2.6), random.uniform(-2.6, 2.6)) for _ in node_heights]
    def at(h):
        s = h/height
        disp = math.tan(lean)*h + bow*height*s*s
        kx = kz = 0.0
        for hn, (dx, dz) in zip(node_heights, kinks):
            if h > hn:
                w = min(1.0, (h-hn)/18.0)
                kx += dx*w
                kz += dz*w
        return (base[0] + ax*disp + kx, base[1] + h, base[2] + az_*disp + kz)
    return at

def build_blade(cfg, base, frames_dir_az, rank, tiller_name, concept_extra, sway_seed,
                color=None, name_override=None, droop_add=0.0, senescence=None,
                growth=None, color0=None, ctrans=None):
    length, wmax, e0d, droopd = cfg["leaf_ranks"][rank]
    length *= random.uniform(0.92, 1.08)
    e0 = math.radians(e0d+random.uniform(-4, 4))
    droop = math.radians(droopd+droop_add+random.uniform(-8, 8))
    # senescence: how far browning has crept in from the tip of this leaf
    sf = senescence if senescence is not None else cfg["senescence"][rank]
    n = 42
    pts, p = [base], base
    rsway = random.Random(sway_seed)
    drift = rsway.uniform(-0.4, 0.4)
    p_arc = rsway.uniform(1.5, 2.2)                 # cantilever curvature varies leaf to leaf
    wob_a = rsway.uniform(0.05, 0.16)               # bend irregularity along the blade
    wob_f = rsway.uniform(3.0, 6.5)
    wob_p = rsway.uniform(0, 6.28)
    tip_hang = max(0.0, sf-0.2)*rsway.uniform(0.5, 1.1)  # old leaves let their tips hang
    for i in range(1, n):
        s = i/(n-1)
        e = e0 - (e0 + droop)*(s**p_arc)
        e -= tip_hang*1.7*max(0.0, (s-0.72)/0.28)**1.6
        e += wob_a*math.sin(s*wob_f + wob_p)*(0.25+0.75*s)
        az = frames_dir_az + drift*s + 0.16*math.sin(s*4.2 + sway_seed) + 0.07*math.sin(s*9.7 + wob_p)
        d = (math.cos(e)*math.cos(az), math.sin(e), math.cos(e)*math.sin(az))
        p = v_add(p, v_scale(d, length/(n-1)))
        pts.append(p)
    frames = transport_frames(pts)
    twist_total = math.radians(random.uniform(30, 80)) * (1 if rank % 2 else -1)
    base_rgb = hex_to_rgb(cfg["blade_colors"][rank])
    brown = (0.45, 0.34, 0.16)
    brown_ratio = tuple(max(0.0, min(2.0, brown[c]/max(0.05, base_rgb[c]))) for c in range(3))
    wsegs = 13
    streaks = [1 + rsway.uniform(-0.055, 0.055) for _ in range(wsegs+1)]  # longitudinal vein streaks
    verts, faces, tints, uvs = [], [], [], []
    for i, c in enumerate(pts):
        s = i/(n-1)
        t, nrm, b = frames[i]
        side = v_norm(v_cross((0, 1, 0), t)) if abs(t[1]) < 0.98 else nrm
        upl = v_norm(v_cross(t, side))
        w = wmax * (0.72 + 0.28*min(1, s/0.16)) * max(0.02, min(1, (1-s)/0.42))**0.62
        fold = 0.42 - 0.30*min(1, s/0.35) + 0.25*max(0, (s-0.75)/0.25)  # V base, flat mid, curl tip
        tau = twist_total * (0.3*s + 0.7*s**3)          # twist concentrates toward the tip
        bright = min(1.18, 0.78 + 0.42*s)
        brk = sf * max(0.0, min(1.0, (s-0.55)/0.45))**1.4
        row_tint = tuple(bright*(1-brk) + brown_ratio[ch]*brk for ch in range(3))
        for j in range(wsegs+1):
            u = j/wsegs*2 - 1
            lat = u*w/2
            # V fold + parallel-vein corrugation + keeled midrib + wavy margins
            vert = fold*w*0.42*(abs(u)**1.45)
            vert += 0.022*w*math.sin(u*math.pi*6.5)
            vert -= 0.055*w*math.exp(-(u/0.14)**2)
            vert += 0.02*w*math.sin(s*52 + u*5.5 + wob_p)*(abs(u)**1.6)
            lat, vert = lat*math.cos(tau) - vert*math.sin(tau), lat*math.sin(tau) + vert*math.cos(tau)
            verts.append(v_add(c, v_add(v_scale(side, lat), v_scale(upl, vert))))
            tints.append(tuple(min(2.0, row_tint[ch]*streaks[j]) for ch in range(3)))
            uvs.append((j/wsegs, s*length/55.0))
    for i in range(n-1):
        for j in range(wsegs):
            p1, p2 = i*(wsegs+1)+j, i*(wsegs+1)+j+1
            p3, p4 = (i+1)*(wsegs+1)+j, (i+1)*(wsegs+1)+j+1
            faces.append((p1, p2, p3))
            faces.append((p2, p4, p3))
    is_flag = cfg["flag"] and rank == len(cfg["leaf_ranks"])-1 and name_override is None
    name = name_override or (f"{tiller_name} · Flag leaf blade" if is_flag else f"{tiller_name} · Leaf blade {rank+1}")
    cid = "FlagLeaves" if is_flag else "Blades"
    final = color or vary(cfg["blade_colors"][rank], dl=0.035)
    add_part("LeafBlade", name, cid, "Leaves", (verts, faces, tints, uvs),
             extra_concepts=(("Blades",) if is_flag else ()) + concept_extra,
             color=final,
             stats={"Blade length": f"{length:.0f} mm", "Max width": f"{wmax:.0f} mm"},
             growth=growth, color0=color0 or mix_hex(final, '#5da23e', 0.5),
             ctrans=ctrans or (40+rank*12, 30))

def grains_along(pan, bpts, bframes, spiral, count, branch_meshes, grain_meshes,
                 s_from=0.15, ripeness=1.0):
    """Attach pedicels, grains, and awns along a branch polyline."""
    top = len(bpts)-1
    awn_tint = (1.16, 1.1, 0.85)
    for g in range(count):
        sg = s_from + (1-s_from)*g/(count-1)
        gi = min(top, int(sg*top))
        gt, gn, gb = bframes[gi]
        ga = g*2.4 + spiral + random.uniform(-0.5, 0.5)
        side = v_add(v_scale(gn, math.cos(ga)), v_scale(gb, math.sin(ga)))
        pd = v_norm(v_add(v_add(v_scale(gt, random.uniform(0.7, 1.1)), v_scale(side, random.uniform(0.4, 0.75))), (0, random.uniform(-0.85, -0.45), 0)))
        ped_len = random.uniform(1.6, 4.2)
        ped_end = v_add(bpts[gi], v_scale(pd, ped_len))
        branch_meshes.append(tube([bpts[gi], ped_end], [0.4, 0.32], segments=4, cap_end=False))
        gaxis = v_norm(v_add(pd, (0, -0.6, 0)))
        glen = random.uniform(*pan["grain_len"])
        gcenter = v_add(ped_end, v_scale(gaxis, glen*0.44))
        # distal grains on a branch fill last: shift them toward green while unripe
        green_k = 0.55*(g/(count-1))*(1-min(1.0, ripeness+0.15))
        tint = (1-0.2*green_k, 1+0.03*green_k, 1-0.45*green_k)
        grain_meshes.append(grain_mesh(gcenter, gaxis, side,
                                       length=glen,
                                       width=random.uniform(*pan["grain_w"]),
                                       thickness=random.uniform(*pan["grain_t"]),
                                       tint=tint))
        # awn: a fine tapering bristle continuing from the lemma tip
        apts, ad, q = [], gaxis, v_add(gcenter, v_scale(gaxis, glen*0.46))
        apts.append(q)
        alen = random.uniform(*pan["awn"])
        drift = v_norm((random.uniform(-1, 1), random.uniform(-0.7, 0.3), random.uniform(-1, 1)))
        for _ in range(4):
            q = v_add(q, v_scale(ad, alen/4))
            apts.append(q)
            ad = v_norm(v_add(ad, v_scale(drift, 0.22)))
        grain_meshes.append(tube(apts, [0.24, 0.18, 0.12, 0.07, 0.03], segments=4, cap_end=True,
                                 tint_fn=lambda k, m: awn_tint))
    return count

def droop_curve(start, d0, length, droop, steps=10):
    pts, q = [start], start
    for k in range(1, steps+1):
        sk = k/steps
        dd = v_norm(v_add(d0, (0, -droop*sk**1.15, 0)))
        q = v_add(q, v_scale(dd, length/steps))
        pts.append(q)
    return pts

def build_panicle(cfg, tip, tip_dir, azimuth, tiller_name, concept_extra,
                  culm=-1, node=-1, heading=63.0):
    """Rachis with spiral primary branches densely set with grains. Returns rachis points."""
    pan = cfg["panicle"]
    pan_growth = {"birth": heading, "dur": 8, "anchor": list(tip), "culm": culm, "node": node}
    grain_growth = {"birth": heading+2, "dur": 8, "anchor": list(tip), "culm": culm, "node": node}
    rachis_len = random.uniform(*pan["rachis"])
    n = 30
    pts, p = [tip], tip
    theta0 = math.acos(max(-1, min(1, tip_dir[1])))          # angle from vertical
    theta_end = math.radians(random.uniform(*pan["theta_end"]))
    zig = random.uniform(0, 6.28)
    for i in range(1, n):
        s = i/(n-1)
        th = theta0 + (theta_end-theta0)*(s**1.25)
        d = (math.sin(th)*math.cos(azimuth), math.cos(th), math.sin(th)*math.sin(azimuth))
        p = v_add(p, v_scale(d, rachis_len/(n-1)))
        # the rachis kinks slightly at each branch insertion rather than curving smoothly
        j = 1.1*math.sin(i*1.9+zig)
        pts.append((p[0]+j*math.cos(azimuth+1.57), p[1]+0.5*math.sin(i*2.7+zig), p[2]+j*math.sin(azimuth+1.57)))
    radii = [2.2*(1 - 0.6*i/(n-1)) for i in range(n)]
    ripeness = random.uniform(*pan["ripeness"])              # panicles ripen at different times
    axis_color = mix_hex(pan["axis_a"], pan["axis_b"], ripeness)
    num_branches = random.randint(10, 12)
    add_part("PanicleAxis", f"{tiller_name} · Panicle rachis", "Panicles", "Panicle",
             tube(pts, radii, segments=8, cap_end=True), extra_concepts=concept_extra,
             color=vary(axis_color, dl=0.02),
             stats={"Rachis length": f"{rachis_len:.0f} mm", "Primary branches": str(num_branches)},
             growth=pan_growth, color0=mix_hex(axis_color, '#87a04a', 0.6), ctrans=(heading+12, 28))
    frames = transport_frames(pts)
    for j in range(num_branches):
        s_b = 0.12 + 0.8*j/(num_branches-1) + random.uniform(-0.02, 0.02)
        bi = int(s_b*(n-1))
        bt, bn, bb = frames[bi]
        spiral = j*GOLDEN + random.uniform(-0.3, 0.3)
        out = v_add(v_scale(bn, math.cos(spiral)), v_scale(bb, math.sin(spiral)))
        d = v_norm(v_add(v_scale(bt, 1.0), v_scale(out, 0.45)))
        blen = random.uniform(*pan["blen"])*(1 - 0.3*s_b)
        droop = random.uniform(*pan["droop"])
        bpts = droop_curve(pts[bi], d, blen, droop)
        bframes = transport_frames(bpts)
        branch_meshes = [tube(bpts, [0.9*(1-0.5*k/10) for k in range(11)], segments=6, cap_end=True)]
        grain_meshes = []
        total = grains_along(pan, bpts, bframes, spiral, random.randint(16, 21),
                             branch_meshes, grain_meshes, s_from=0.1, ripeness=ripeness)
        if random.random() < 0.8:                            # a secondary branchlet near the base
            si = random.randint(1, 3)
            st, sn, sb2 = bframes[si]
            sd = v_norm(v_add(v_add(v_scale(st, 0.8), v_scale(sn, math.cos(spiral+2.1)*0.6)),
                              v_scale(sb2, math.sin(spiral+2.1)*0.6)))
            spts = droop_curve(bpts[si], sd, random.uniform(28, 44), droop*1.2, steps=6)
            sframes = transport_frames(spts)
            branch_meshes.append(tube(spts, [0.55*(1-0.5*k/6) for k in range(7)], segments=5, cap_end=True))
            total += grains_along(pan, spts, sframes, spiral+2.1, random.randint(5, 8),
                                  branch_meshes, grain_meshes, s_from=0.25, ripeness=ripeness)
        add_part("PanicleBranch", f"{tiller_name} · Panicle branch {j+1}", "Panicles", "Panicle",
                 merge(branch_meshes), extra_concepts=concept_extra,
                 color=vary(axis_color, dl=0.03),
                 stats={"Branch length": f"{blen:.0f} mm", "Grains carried": str(total)},
                 growth=pan_growth, color0=mix_hex(axis_color, '#87a04a', 0.6), ctrans=(heading+12, 28))
        gcolor = vary(mix_hex(pan["grain_a"], pan["grain_b"],
                              min(1, max(0, ripeness+random.uniform(-0.15, 0.15)))), dl=0.035)
        add_part("Grain", f"{tiller_name} · Grains, branch {j+1}", "Grains", "Grain",
                 merge(grain_meshes), extra_concepts=concept_extra,
                 color=gcolor,
                 stats={"Grains": str(total),
                        "Grain size": f"≈ {sum(pan['grain_len'])/2:.0f} × {sum(pan['grain_w'])/2:.1f} mm",
                        "Awn length": f"{pan['awn'][0]}–{pan['awn'][1]} mm"},
                 growth=grain_growth, color0=mix_hex(gcolor, '#8fae55', 0.7), ctrans=(heading+9, 26))
    return pts

def build_grain_cutaway(pan, anchor, azimuth, culm=-1, node=-1, heading=63.0):
    """A grain sliced longitudinally: husk shell, starchy endosperm, and embryo."""
    cut_growth = {"birth": heading+4, "dur": 7, "anchor": list(anchor), "culm": culm, "node": node}
    base_dir = v_norm((math.cos(azimuth)*0.3, -1.0, math.sin(azimuth)*0.3))
    ped_end = v_add(anchor, v_scale(base_dir, 10))
    gaxis = v_norm(v_add(base_dir, (0, -0.2, 0)))
    length, width, thickness = 9.8, 4.2, 3.0
    gcenter = v_add(ped_end, v_scale(gaxis, length*0.5))
    # orient the cut so the open face looks toward the default camera (+z)
    a = v_norm(gaxis)
    s2 = v_norm(v_sub((0, 0, -1), v_scale(a, v_dot((0, 0, -1), a))))
    s1 = v_norm(v_cross(s2, a))
    husk = [tube([anchor, ped_end], [0.45, 0.35], segments=5, cap_end=False),
            half_grain_mesh(gcenter, a, s1, s2, length, width, thickness, cap=False)]
    add_part("Cutaway", "Grain cutaway · Lemma & palea (husk)", "GrainCutaway", "Grain",
             merge(husk), color='#d0a035',
             stats={"Grain size": f"{length:.0f} × {width:.1f} mm"},
             growth=cut_growth, color0='#8fae55', ctrans=(heading+9, 26))
    endo_c = v_add(gcenter, v_scale(s2, 0.18))
    add_part("Cutaway", "Grain cutaway · Endosperm", "GrainCutaway", "Grain",
             half_grain_mesh(endo_c, a, s1, s2, length*0.86, width*0.84, thickness*0.8, cap=True),
             color='#efe8d6', stats={"Share of grain": "≈ 90 %"},
             growth=cut_growth, color0='#d9e0c2', ctrans=(heading+9, 26))
    emb_c = v_add(v_add(gcenter, v_scale(a, -length*0.27)), v_scale(s2, 0.12))
    add_part("Cutaway", "Grain cutaway · Embryo", "GrainCutaway", "Grain",
             grain_mesh(emb_c, a, s1, length=3.1, width=1.9, thickness=1.5, lat=6, lon=8),
             color='#bb8f3e', stats={"Share of grain": "≈ 3 %"},
             growth=cut_growth)

# --------------------------------------------------------------- stage build
def build_stage(stage, cfg):
    global OUT_DIR, elements, system_map, concept_members, counter
    OUT_DIR = f"rice_obj_{stage}"
    elements, system_map, concept_members, counter = [], {}, {}, {}
    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR)
    random.seed(7)

    # ---- developmental calendar (days after sowing, ~120-day season) ----
    n_ranks = len(cfg["leaf_ranks"])
    def rank_f(ni):
        return ni/max(1, n_ranks-1)
    def tiller_birth(t):
        return 0 if t == 0 else 18 + (t-1)*4.0
    def leaf_birth(t, ni):
        base = 6 + 46*rank_f(ni)**1.15    # phyllochron rhythm on the main culm
        return base if t == 0 else tiller_birth(t) + 28*rank_f(ni)**1.1
    def elong_day(ni):
        return 40 + 22*rank_f(ni)**1.3    # only upper internodes elongate visibly
    def heading_day(t):
        return 63.0 if t == 0 else 64.5 + t*0.8
    growth_culms = []

    crown_y = cfg["crown_y"]
    crown_r = cfg["r0"]*2.4
    crown_pts = [(0, crown_y-crown_r*2.1, 0), (0, crown_y-crown_r, 0),
                 (0, crown_y+2, 0), (0, crown_y+crown_r*1.2, 0)]
    crown_radii = [crown_r*0.7, crown_r, crown_r*0.96, crown_r*0.66]
    add_part("Crown", "Tillering crown", "Culms", "Stem",
             tube(crown_pts, crown_radii, segments=14, cap_start=True, cap_end=True,
                  tint_fn=lambda k, m: (0.72+0.28*k/(m-1),)*3),
             color=vary(cfg["crown_color"]),
             stats={"Tillers": str(cfg["tillers"]), "Roots": str(cfg["roots"])},
             growth={"birth": 0, "dur": 12, "anchor": list(crown_pts[0])})

    if cfg.get("seed_husk"):
        # the spent seed still clinging to the crown of a young plant
        husk_axis = v_norm((0.55, -0.9, 0.25))
        husk_center = v_add((6.0, crown_y-14, 3.0), v_scale(husk_axis, 3.0))
        add_part("Seed", "Spent seed (caryopsis)", "Seed", "Grain",
                 grain_mesh(husk_center, husk_axis, (0, 0, 1),
                            length=7.8, width=3.3, thickness=2.3, tint=(0.95, 0.9, 0.8)),
                 color='#ab9668',
                 stats={"Grain size": "≈ 8 × 3.3 mm"},
                 growth={"birth": 0, "dur": 3, "anchor": list(husk_center)})

    print(f"[{stage}] roots...")
    for r in range(cfg["roots"]):
        az = random.uniform(0, 2*math.pi)
        start = (math.cos(az)*random.uniform(2, crown_r*0.7), crown_y - random.uniform(6, crown_r*1.6),
                 math.sin(az)*random.uniform(2, crown_r*0.7))
        spread = random.uniform(0.25, 1.25)
        d = v_norm((math.cos(az)*spread, -1.0, math.sin(az)*spread))
        pts, p = [start], start
        gravity = 0.10
        for step in range(cfg["root_nsteps"]):
            p = v_add(p, v_scale(d, random.uniform(*cfg["root_steps"])))
            pts.append(p)
            jitter = (random.uniform(-.45, .45), random.uniform(-.2, .2), random.uniform(-.45, .45))
            gravity = min(0.55, gravity + 0.06)
            d = v_norm(v_add(v_add(d, jitter), (0, -gravity, 0)))
            if p[1] < crown_y*0.17:
                d = v_norm((d[0], d[1]*0.25, d[2]))
        smooth = catmull_rom(pts, 3)
        n = len(smooth)
        radii = [cfg["root_r"]*(1 - 0.82*(i/(n-1))**1.2) for i in range(n)]
        # darker where the root emerges from the crown, paling toward the tip
        parts = [tube(smooth, radii, segments=7, cap_end=True,
                      tint_fn=lambda k, m: (min(1.0, 0.66+0.34*k/(m*0.3)),)*3)]
        laterals = random.randint(0, 2)
        for _ in range(laterals):
            at = random.randint(int(n*0.3), int(n*0.8))
            lp, ld = [smooth[at]], v_norm(v_add(v_norm(v_sub(smooth[at], smooth[at-1])),
                                                (random.uniform(-.9, .9), random.uniform(-.6, .1), random.uniform(-.9, .9))))
            q = smooth[at]
            for _ in range(5):
                q = v_add(q, v_scale(ld, random.uniform(12, 20)*cfg["root_r"]/1.55))
                lp.append(q)
                ld = v_norm(v_add(ld, (random.uniform(-.3, .3), -0.28, random.uniform(-.3, .3))))
            ls = catmull_rom(lp, 3)
            parts.append(tube(ls, [0.55*(1 - 0.8*i/(len(ls)-1)) for i in range(len(ls))], segments=5))
        rcol = vary(cfg["root_color"], dl=0.06)
        rbirth = 4 + 56*(r/max(1, cfg["roots"]))**1.3
        add_part("Root", f"Adventitious root {r+1}", "Roots", "Root", merge(parts),
                 color=rcol,
                 stats={"Root length": f"{polyline_length(smooth):.0f} mm", "Laterals": str(laterals)},
                 growth={"birth": rbirth, "dur": 22, "anchor": list(start)},
                 color0=mix_hex(rcol, '#cabc98', 0.6), ctrans=(rbirth+8, 30))

    print(f"[{stage}] tillers, leaves{', panicles' if cfg['panicle'] else ''}...")
    total_tillers = cfg["tillers"] + cfg.get("late_tillers", 0)
    for t in range(total_tillers):
        fertile = t < cfg["tillers"]
        tiller_name = "Main culm" if t == 0 else (f"Tiller {t+1}" if fertile else f"Tiller {t+1} (late)")
        tiller_concept = f"TillerC{t+1}"
        concept_members[tiller_concept] = []
        many = max(1, total_tillers-1)
        az = 0 if t == 0 else (t-1)*2*math.pi/many + random.uniform(-0.3, 0.3)
        base_r = 0 if t == 0 else random.uniform(crown_r*0.5, crown_r*0.9)
        base = (math.cos(az)*base_r, crown_y, math.sin(az)*base_r)
        lean = 2.0 if t == 0 else random.uniform(5, 20 if fertile else 26)
        height = random.uniform(*(cfg["height_main"] if t == 0 else cfg["height_tiller"]))
        if not fertile:
            height *= random.uniform(0.45, 0.6)      # late tillers stay short and vegetative
        bow = random.uniform(0.02, 0.05)
        ranks_used = n_ranks if fertile else min(n_ranks, 5)
        internode_lengths = [height*f for f in cfg["internode_fracs"][:ranks_used]]
        node_heights = []
        acc = 0.0
        for ilen in internode_lengths[:-1]:
            acc += ilen
            node_heights.append(acc)
        line = culm_line(base, az, lean, height, bow, node_heights)
        culm_vecs = []
        h = 0.0
        for ni, ilen in enumerate(internode_lengths):
            samples = 12
            pts = [line(h + ilen*k/(samples-1)) for k in range(samples)]
            r0 = cfg["r0"] - ni*cfg["r_step"]
            radii = []
            for k in range(samples):
                rr = r0 - (cfg["r_step"]*k/(samples-1))
                mm = ilen*k/(samples-1)
                rr *= 1 + 0.22*math.exp(-(mm/9.0)**2)          # node bulge at the base
                radii.append(rr)
            # dark node ring at the joint, faint waxy bloom toward the top
            def internode_tint(k, m, _ilen=ilen):
                mm = _ilen*k/(m-1)
                t = min(1.0, mm/14.0)
                return (0.68*(1-t) + (0.97 + 0.13*k/(m-1))*t,)*3
            culm_vecs.append([round(v, 2) for v in v_sub(line(h+ilen), line(h))])
            icol = vary(cfg["internode_colors"][ni], dl=0.025)
            add_part("Internode", f"{tiller_name} · Internode {ni+1}", "Culms", "Stem",
                     tube(pts, radii, segments=12, cap_start=True, cap_end=True,
                          tint_fn=internode_tint),
                     extra_concepts=(tiller_concept,),
                     color=icol,
                     stats={"Length": f"{ilen:.0f} mm", "Diameter": f"{2*r0:.1f} mm"},
                     growth={"birth": elong_day(ni)+(0 if t == 0 else min(4, (t-1)*0.6)), "dur": 9,
                             "anchor": list(pts[0]), "culm": t, "node": ni},
                     color0=mix_hex(icol, '#6f9a45', 0.55), ctrans=(65+ni*5, 30))

            # leaf sheath wrapping the culm from this node upward
            last = ni == len(internode_lengths)-1
            sheath_len = ilen*random.uniform(0.72, 0.85) if not last else min(170, ilen*0.6)
            s_samples = 8
            spts = [line(h + sheath_len*k/(s_samples-1)) for k in range(s_samples)]
            sradii = [r0 + cfg["sheath_extra"] - cfg["sheath_extra"]*0.55*k/(s_samples-1) for k in range(s_samples)]
            sradii[-1] *= 1.35                                  # flare at the ligule
            lb = leaf_birth(t, ni)
            scol = vary(cfg["sheath_colors"][ni], dl=0.03)
            add_part("LeafSheath", f"{tiller_name} · Leaf sheath {ni+1}", "Sheaths", "Sheath",
                     tube(spts, sradii, segments=10, cap_start=True, cap_end=True,
                          tint_fn=lambda k, m: (0.78+0.3*k/(m-1),)*3),
                     extra_concepts=(tiller_concept,),
                     color=scol,
                     stats={"Sheath length": f"{sheath_len:.0f} mm"},
                     growth={"birth": lb-2, "dur": 12, "anchor": list(spts[0]), "culm": t, "node": ni},
                     color0=mix_hex(scol, '#61933f', 0.5), ctrans=(55+ni*8, 30))

            leaf_az = az + (ni % 2)*math.pi + random.uniform(-0.28, 0.28)
            top_p = line(h + sheath_len)
            build_blade(cfg, top_p, leaf_az, ni, tiller_name, (tiller_concept,), sway_seed=t*10+ni,
                        growth={"birth": lb, "dur": 14, "anchor": list(top_p), "culm": t, "node": ni})

            # ligule collar and two auricle horns at the sheath-blade junction
            lig_h = cfg["ligule_h"]
            cdir = v_norm(v_sub(line(h+sheath_len+5), line(h+max(0, sheath_len-5))))
            rtop = sradii[-1]/1.35
            collar = tube([top_p, v_add(top_p, v_scale(cdir, lig_h))],
                          [rtop*1.02, rtop*1.32], segments=10, cap_end=True)
            lig_meshes = [collar]
            aur_side = (math.cos(leaf_az+math.pi/2), 0, math.sin(leaf_az+math.pi/2))
            for sgn in (1, -1):
                a0 = v_add(top_p, v_scale(aur_side, sgn*rtop))
                adir = v_norm(v_add(v_add(cdir, v_scale(aur_side, sgn*0.9)), (0, .4, 0)))
                apts = [a0, v_add(a0, v_scale(adir, lig_h*0.8)), v_add(a0, v_scale(adir, lig_h*1.4))]
                lig_meshes.append(tube(apts, [0.5*lig_h/4, 0.3*lig_h/4, 0.08], segments=5, cap_end=True))
            add_part("Ligule", f"{tiller_name} · Ligule & auricles {ni+1}", "Ligules", "Sheath",
                     merge(lig_meshes), extra_concepts=(tiller_concept,),
                     color=vary('#dde1c4', dl=0.03),
                     stats={"Collar height": f"{lig_h:.0f} mm"},
                     growth={"birth": lb+6, "dur": 4, "anchor": list(top_p), "culm": t, "node": ni})
            h += ilen

        if cfg.get("dead_leaves") and t in (2, 5):
            # a fully senesced lower leaf still hanging on
            dead_base = line(internode_lengths[0]*0.8)
            build_blade(cfg, dead_base, az+2.3+random.uniform(-0.3, 0.3), 0,
                        tiller_name, (tiller_concept,), sway_seed=t*10+9,
                        color=vary('#9c7f45', dl=0.04),
                        name_override=f"{tiller_name} · Senescent leaf",
                        droop_add=48, senescence=1.0,
                        growth={"birth": leaf_birth(t, 0), "dur": 14,
                                "anchor": list(dead_base), "culm": t, "node": 0},
                        color0='#6b9440', ctrans=(52, 22))

        growth_culms.append(culm_vecs)
        if cfg["panicle"] and fertile:
            tip = line(height)
            tip_dir = v_norm(v_sub(line(height), line(height-30)))
            panicle_az = az if t > 0 else random.uniform(0, 2*math.pi)
            hd = heading_day(t)
            rachis_pts = build_panicle(cfg, tip, tip_dir, panicle_az, tiller_name, (tiller_concept,),
                                       culm=t, node=len(internode_lengths), heading=hd)
            if t == 0 and cfg["cutaway"]:
                build_grain_cutaway(cfg["panicle"], rachis_pts[8], panicle_az,
                                    culm=t, node=len(internode_lengths), heading=hd)

    concept_names = {
        "Roots": "Fibrous root system",
        "Culms": "Culms (stems)",
        "Sheaths": "Leaf sheaths",
        "Ligules": "Ligules & auricles",
        "Blades": "Leaf blades",
        "FlagLeaves": "Flag leaves",
        "Panicles": "Panicles (inflorescences)",
        "Grains": "Grains (spikelets)",
        "GrainCutaway": "Grain in cross-section",
        "Seed": "Spent seed (caryopsis)",
    }
    for t in range(cfg["tillers"] + cfg.get("late_tillers", 0)):
        fertile = t < cfg["tillers"]
        concept_names[f"TillerC{t+1}"] = "Main culm" if t == 0 else (f"Tiller {t+1}" if fertile else f"Tiller {t+1} (late)")

    concepts = [{"id": cid, "name": concept_names[cid], "elements": members}
                for cid, members in concept_members.items() if members]

    with open(f"concept_map_{stage}.json", "w") as f:
        json.dump({"elements": elements, "concepts": concepts, "growthCulms": growth_culms}, f, indent=1)
    with open(f"system_map_{stage}.json", "w") as f:
        json.dump(system_map, f, indent=1)
    print(f"[{stage}] {len(elements)} organ meshes across {len(concepts)} concepts.")

for stage, cfg in STAGES.items():
    build_stage(stage, cfg)
