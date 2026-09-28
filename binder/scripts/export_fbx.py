"""Blender -> Unity export, executed inside the live Blender session.

Run by the pi-unity-blender binder. The configuration blob is interpolated at
transfer time (see binder/script-template.ts), because the Blender bridge's
execute-python request carries no custom-argument channel: it only passes
OUTPUT_BLEND_PATH / WORKSPACE_PATH / ITERATION_PATH as globals. So the values
this script needs are baked into the file it is run from.

What crosses the boundary
-------------------------
FBX is the only mesh interchange both applications read well, and it carries
basic material slots. We export with path_mode='COPY' so Blender's textures are
embedded in the FBX rather than referenced by absolute path -- Unity's importer
has no way to resolve a Linux path from the .blend's machine.

What does NOT cross
-------------------
Node-based shader graphs. A Principled BSDF becomes an approximation made of
standard properties; anything procedural is flattened or dropped. The binder
reports the material count so the caller knows what to check by eye.
"""

import json
import os

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]

# pi-lens-ignore: ast-grep:unchecked-throwing-call-python
CONFIG = json.loads(r"""__PI_BINDER_CONFIG__""")

out_path = CONFIG["outPath"]
texture_dir = CONFIG.get("textureDir")
object_names = CONFIG.get("objectNames") or []

# Resolve the requested objects. An empty list means "everything selectable",
# which mirrors what the user sees as the transfer scope.
if object_names:
    objects = [bpy.data.objects.get(name) for name in object_names]
    missing = [name for name, obj in zip(object_names, objects, strict=True) if obj is None]
    if missing:
        raise RuntimeError(
            f"No Blender object named: {', '.join(missing)}. "
            f"Available: {', '.join(sorted(o.name for o in bpy.data.objects)) or '(empty scene)'}"
        )
else:
    objects = list(bpy.context.selected_objects) or [
        obj for obj in bpy.data.objects if obj.type in {"MESH", "CURVE", "SURFACE", "FONT"}
    ]

if not objects:
    raise RuntimeError("Nothing to export: no objects matched the transfer scope.")

# bpy.ops exporters act on the selection, not on a list argument.
bpy.ops.object.select_all(action="DESELECT")
for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]

# Ask the operator which properties IT accepts instead of trusting a keyword
# list written against some other Blender version. Two names here were simply
# wrong on Blender 5.2 ("bake_force_startend_keying" is
# "bake_anim_force_startend_keying"; "path_mode_keep_nla_strips" is gone), and
# a wrong keyword is a hard TypeError at export time, not a warning.
_fbx_props = {p.identifier for p in bpy.ops.export_scene.fbx.get_rna_type().properties}
_wanted = {
    "filepath": out_path,
    "use_selection": True,
    # Embed textures: the Unity importer cannot follow Blender-relative paths.
    "path_mode": "COPY",
    "embed_textures": True,
    "apply_scale_options": "FBX_SCALE_UNITS",
    # Unity's importer applies transforms itself; baking avoids a double scale.
    "bake_space_transform": False,
    "object_types": {"MESH", "EMPTY"},
    "use_mesh_modifiers": True,
    "mesh_smooth_type": "FACE",
    "add_leaf_bones": False,
    "bake_anim": True,
    "bake_anim_use_all_bones": False,
    "bake_anim_use_nla_strips": False,
    "bake_anim_use_all_actions": False,
    "bake_anim_force_startend_keying": True,
}
_dropped = sorted(k for k in _wanted if k not in _fbx_props)
_kwargs = {k: v for k, v in _wanted.items() if k in _fbx_props}
if _dropped:
    # Not fatal: these are exporter conveniences, not correctness. Say so rather
    # than pretending the transfer was configured exactly as written.
    print(f"NOTE: this Blender's FBX exporter does not support {_dropped}; skipped.")
bpy.ops.export_scene.fbx(**_kwargs)

if not os.path.exists(out_path):
    raise RuntimeError(f"Blender reported success but no FBX was written to {out_path}")

# Report the material situation rather than pretending it round-tripped.
materials = set()
for obj in objects:
    if obj.type != "MESH":
        continue
    for slot in getattr(obj.data, "materials", []):
        if slot is not None:
            materials.add(slot.name)

textures = []
if texture_dir:
    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    os.makedirs(texture_dir, exist_ok=True)
    for image in bpy.data.images:
        # Generated images have no file to copy; skip them rather than failing.
        if image.source == "FILE" and image.filepath:
            target = os.path.join(texture_dir, os.path.basename(bpy.path.abspath(image.filepath)))
            try:
                image.save_render(target)
                textures.append(os.path.basename(target))
            except Exception as error:
                # A texture the user cannot write is not a reason to fail the
                # whole transfer; the mesh still crossed, so report and continue.
                print(f"binder: skipped texture {image.name}: {error}")

print(
    json.dumps(
        {
            "fbxPath": out_path,
            "objectNames": [obj.name for obj in objects],
            "materialNames": sorted(materials),
            "textureNames": textures,
            "vertexTotal": sum(
                len(obj.data.vertices) for obj in objects if obj.type == "MESH"
            ),
        }
    )
)
