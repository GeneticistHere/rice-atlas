"""Headless Blender refinement stage for the rice FSPM organ meshes.

Usage: .venv-bpy/bin/python scripts/blender_refine.py SRC_DIR DST_DIR

Leaf blades gain real thickness via a Solidify modifier (the FSPM emits them
as zero-thickness sheets); every other organ is copied through untouched.
Vertex colors (tint multipliers, up to 2.0) and UVs round-trip losslessly
through Blender's OBJ pipeline.
"""
import os
import shutil
import sys

import bpy

argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
src, dst = argv[0], argv[1]
os.makedirs(dst, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

refined = copied = 0
for name in sorted(os.listdir(src)):
    if not name.endswith('.obj'):
        continue
    sp, dp = os.path.join(src, name), os.path.join(dst, name)
    if not name.startswith('LeafBlade_'):
        shutil.copyfile(sp, dp)
        copied += 1
        continue
    bpy.ops.wm.obj_import(filepath=sp)
    ob = bpy.context.selected_objects[0]
    mod = ob.modifiers.new('sol', 'SOLIDIFY')
    mod.thickness = 0.45          # mm; rice blades are thin but not infinitely so
    mod.offset = 0.0
    mod.use_even_offset = True
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier='sol')
    bpy.ops.object.shade_smooth()
    bpy.ops.wm.obj_export(filepath=dp, export_selected_objects=True,
                          export_materials=False, export_colors=True,
                          export_triangulated_mesh=True, export_normals=True,
                          export_uv=True)
    bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    refined += 1
print(f'blender_refine: {refined} blades solidified, {copied} organs copied -> {dst}')
