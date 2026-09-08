"""Export a whole rice stage as a portable glTF binary (.glb).

Usage: .venv-bpy/bin/python scripts/export_gltf.py STAGE [OUT.glb]

Reads the fully refined + AO-baked organ OBJs (rice_obj_<stage>_ao), bakes each
organ's base color and per-vertex tint (veins, senescence, AO) into a real
COLOR_0 vertex-color layer, assigns per-system PBR materials that mirror the
viewer's finish table, names every node after its organ, groups organs into
per-system collections, and writes one .glb usable in Blender, Unity, Unreal,
Godot, or any glTF viewer.
"""
import json
import os
import sys

import bpy

argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
stage = argv[0]
out_path = os.path.abspath(argv[1] if len(argv) > 1 else f'exports/rice-{stage}.glb')
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, f'rice_obj_{stage}_ao')
if not os.path.isdir(src):
    src = os.path.join(root, f'rice_obj_{stage}')
os.makedirs(os.path.dirname(out_path), exist_ok=True)

concept = json.load(open(os.path.join(root, f'concept_map_{stage}.json')))
system_of = json.load(open(os.path.join(root, f'system_map_{stage}.json')))
elements = {e['id']: e for e in concept['elements']}

# Mirrors FINISH in app/scene.tsx (roughness per botanical system).
FINISH = {'Leaves': .48, 'Sheath': .55, 'Stem': .62, 'Grain': .42,
          'Panicle': .60, 'Root': .85}
SYSTEM_FALLBACK = {'Grain': '#c78f2c', 'Panicle': '#97803a', 'Leaves': '#568a37',
                   'Sheath': '#699541', 'Stem': '#93a352', 'Root': '#a8825b'}


def srgb_to_linear(c):
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4


def linear_to_srgb(c):
    return c*12.92 if c <= 0.0031308 else 1.055*c**(1/2.4) - 0.055


def hex_linear(h):
    h = h.lstrip('#')
    return tuple(srgb_to_linear(int(h[i:i+2], 16)/255.0) for i in (0, 2, 4))


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

materials = {}
for sysname, rough in FINISH.items():
    mat = bpy.data.materials.new(sysname)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = 0.03
    attr = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    mat.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    materials[sysname] = mat

collections = {}
for sysname in FINISH:
    col = bpy.data.collections.new(sysname)
    scene.collection.children.link(col)
    collections[sysname] = col

count = 0
for name in sorted(os.listdir(src)):
    if not name.endswith('.obj'):
        continue
    oid = name[:-4]
    el = elements.get(oid, {})
    sysname = system_of.get(oid, 'Stem')
    base = hex_linear(el.get('color') or SYSTEM_FALLBACK.get(sysname, '#93a352'))

    bpy.ops.wm.obj_import(filepath=os.path.join(src, name), global_scale=0.001)
    ob = bpy.context.selected_objects[0]
    me = ob.data

    # OBJ import sRGB-decodes the v-line tint multipliers; undo that, then fold
    # the organ base color in so COLOR_0 holds the final linear surface color.
    ca = me.color_attributes[0] if me.color_attributes else None
    if ca is None:
        ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
        for item in ca.data:
            item.color = (*base, 1.0)
    else:
        for item in ca.data:
            r, g, b, a = item.color
            item.color = (min(1.0, base[0]*linear_to_srgb(r)),
                          min(1.0, base[1]*linear_to_srgb(g)),
                          min(1.0, base[2]*linear_to_srgb(b)), 1.0)

    me.materials.clear()
    me.materials.append(materials.get(sysname, materials['Stem']))
    ob.name = el.get('name', oid)
    ob['organ_id'] = oid
    ob['system'] = sysname
    ob['concept'] = el.get('conceptId', '')
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    collections.get(sysname, collections['Stem']).objects.link(ob)
    count += 1
    if count % 100 == 0:
        print(f'export_gltf: imported {count} organs')

print(f'export_gltf: {count} organs; writing {out_path}')
bpy.ops.export_scene.gltf(
    filepath=out_path, export_format='GLB', export_extras=True,
    export_hierarchy_full_collections=True, export_materials='EXPORT',
    export_normals=True, export_apply=True)
print(f'export_gltf: wrote {out_path} ({os.path.getsize(out_path)/1e6:.1f} MB)')
