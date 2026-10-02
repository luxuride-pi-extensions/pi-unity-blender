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

# A curve, surface or font object exports NOTHING under the object_types above:
# the FBX exporter writes only the types it is told to, so a CURVE-only
# selection produced a valid, non-empty .fbx that reimports as an empty scene
# and a summary reporting zero vertices. A curve is not a mesh, so it needs
# converting before the exporter will carry it.
#
# On a COPY, deliberately. object.convert() rewrites the object in place, which
# would turn the user's curve into a mesh in their open .blend -- and the binder
# saves that .blend, so a transfer would silently restructure the scene it was
# only meant to read. The copies are removed again once the FBX is written, by
# which point the geometry is in the file.
converted_from: dict[str, str] = {}
convertible = [obj for obj in objects if obj.type in {"CURVE", "SURFACE", "FONT"}]
if convertible:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in convertible:
        copy = obj.copy()
        copy.data = obj.data.copy()
        bpy.context.scene.collection.objects.link(copy)
        copy.select_set(True)
        converted_from[copy.name] = obj.name
    bpy.context.view_layer.objects.active = bpy.context.view_layer.objects[convertible[0].name]
    bpy.ops.object.convert(target="MESH")
    # Re-fetch by the copy's own name: `objects` still holds the ORIGINALS, and
    # filtering that list by the copy's name yields nothing, which exports the
    # curve's absence while the NOTE above claims it was sent.
    converted = [bpy.data.objects[name] for name in converted_from if bpy.data.objects.get(name)]
    objects = [obj for obj in objects if obj.type != "CURVE" and obj.type != "SURFACE" and obj.type != "FONT"] + converted
    print(
        f"NOTE: exported {len(convertible)} curve/surface/font object(s) as mesh copies "
        f"({', '.join(converted_from.values())}); the originals are unchanged in the scene."
    )

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
    # ARMATURE is not optional. Without it the FBX exporter writes the mesh and
    # leaves the bones behind, and the file reimports with the rig gone: a
    # Blender -> Unity transfer of a rigged object delivered a static mesh that
    # looked complete and the summary reported it as one. Measured both ways --
    # exported with {MESH, EMPTY} the file reimports with no armature at all,
    # with ARMATURE added the same rig comes back with its bones intact.
    "object_types": {"MESH", "EMPTY", "ARMATURE"},
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

# The summary is assembled HERE, before the temporary copies are removed, and
# the copy's name is reported as the OBJECT's name. Reading obj.data after the
# removal is the trap: a StructRNA of a removed object is dead, and the script
# dies on it with a ReferenceError that reads like a Blender bug. Reporting
# "MyCurve.001" instead of "MyCurve" is the other half of the same mistake --
# the copy is an implementation detail and the user asked for the curve.
exported_names = [converted_from.get(obj.name, obj.name) for obj in objects]
exported_materials = set()
for obj in objects:
    if obj.type != "MESH":
        continue
    for slot in getattr(obj.data, "materials", []):
        if slot is not None:
            exported_materials.add(slot.name)
# A converted curve copy carries no material slots -- the conversion drops them
# -- so the ORIGINAL's slots are read too, or a curve's only material is
# reported as not having crossed when it is in the FBX.
for original_name in converted_from.values():
    original = bpy.data.objects.get(original_name)
    for slot in getattr(getattr(original, "data", None), "materials", []):
        if slot is not None:
            exported_materials.add(slot.name)
exported_vertex_total = sum(len(obj.data.vertices) for obj in objects if obj.type == "MESH")

# The temporary mesh copies have done their job: the geometry is in the FBX.
# Removing them here rather than leaving them keeps the scene the user sees the
# scene they had, and keeps a SECOND transfer from seeing them in its scope.
for copy_name in converted_from:
    temporary = bpy.data.objects.get(copy_name)
    if temporary is not None:
        temporary_data = temporary.data
        bpy.data.objects.remove(temporary, do_unlink=True)
        if temporary_data.users == 0 and isinstance(temporary_data, bpy.types.Mesh):
            bpy.data.meshes.remove(temporary_data)

if not os.path.exists(out_path):
    raise RuntimeError(f"Blender reported success but no FBX was written to {out_path}")

# Report the material situation rather than pretending it round-tripped.
materials = exported_materials

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
            "objectNames": exported_names,
            "materialNames": sorted(materials),
            "textureNames": textures,
            "vertexTotal": exported_vertex_total,
        }
    )
)
