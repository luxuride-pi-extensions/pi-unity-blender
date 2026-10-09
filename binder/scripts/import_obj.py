"""Unity -> Blender import, executed inside the live Blender session.

Run by the pi-unity-blender binder. The configuration blob is interpolated at
transfer time (see binder/script-template.ts).

Unity exports OBJ + MTL because Blender reads OBJ natively on every version,
while Unity's FBX *exporter* is not part of any standard package. The cost is
that the material graph is flattened to MTL's small property set (Kd, Ks, Ns,
d, opacity) -- see export_obj in the Unity bridge for exactly what survives.

Blender 4.x renamed the OBJ importer to wm.obj_import; 3.x uses
import_scene.obj. Both are tried so the binder is not pinned to one version.
"""

import json
import os

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy and mathutils are provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]
from mathutils import Matrix  # pyright: ignore[reportMissingImports]

# pi-lens-ignore: ast-grep:unchecked-throwing-call-python
CONFIG = json.loads(r"""__PI_BINDER_CONFIG__""")

obj_path = CONFIG["objPath"]
mtl_path = CONFIG.get("mtlPath")
object_names = CONFIG.get("objectNames") or []
collection_name = CONFIG.get("collectionName") or "Pi_Imported"

if not os.path.exists(obj_path):
    raise RuntimeError(f"Unity reported a successful export but no OBJ exists at {obj_path}")

before = set(bpy.data.objects)
bpy.ops.object.select_all(action="DESELECT")

# The bridge writes `g <GameObject name>` but no `o` line, so Blender's OBJ
# importer falls back to the FILE name and the imported object is called
# "transfer" instead of the GameObject it came from. That silently breaks object
# identity across a Unity -> Blender -> Unity round trip, which is the main
# reason to export by name at all. use_split_groups is the keyword that asks
# for group naming -- but it is BLENDER 4.x-ONLY, where wm.obj_import replaced
# import_scene.obj, and the 3.x operator has no equivalent and no such keyword.
# Asking for it unconditionally is a hard "keyword unrecognized" TypeError on
# 3.x, so it is filtered against the live RNA below like every other keyword,
# and on 3.x the importer's own defaults apply and object names fall back to the
# file name.
#
# Keyword names have moved between Blender versions, so filter against the real
# RNA instead of trusting a fixed set.
_IMPORT_KWARGS = {
    "filepath": obj_path,
    "forward_axis": "NEGATIVE_Z",
    "up_axis": "Y",
    "use_split_groups": True,
}


def _importer_rna():
    for module_name, operator_name in (("wm", "obj_import"), ("import_scene", "obj")):
        module = getattr(bpy.ops, module_name, None)
        operator = getattr(module, operator_name, None) if module else None
        if operator is not None:
            return operator, operator.get_rna_type()
    return None, None


def _supported_kwargs(desired, rna):
    """Keep only the keywords this Blender's importer really accepts."""
    supported = {prop.identifier for prop in rna.properties}
    dropped = sorted(set(desired) - supported)
    if dropped:
        print(f"NOTE: this Blender's OBJ importer does not support {dropped}; skipped")
    return {key: value for key, value in desired.items() if key in supported}


# The operator is resolved ONCE, the same way its RNA was, and then CALLED --
# not re-derived by catching AttributeError. A blanket except would also swallow
# an AttributeError raised for an unrelated reason from inside a working
# importer, and then silently re-run the other version's operator over the same
# file, which is how one transfer ends up importing everything twice.
_operator, _rna = _importer_rna()
if _operator is None or _rna is None:
    raise RuntimeError("This Blender build exposes no OBJ importer (tried wm.obj_import and import_scene.obj).")
_kwargs = _supported_kwargs(_IMPORT_KWARGS, _rna)
_operator(**_kwargs)

imported = [obj for obj in bpy.data.objects if obj not in before]
if not imported:
    raise RuntimeError("The OBJ import produced no objects. The file may be empty or malformed.")

# Group under one collection so a later transfer can remove or re-export the
# whole batch. Objects land in the active collection otherwise, mixed in with
# whatever else the user had selected.
collection = bpy.data.collections.get(collection_name) or bpy.data.collections.new(collection_name)
if collection.name not in {child.name for child in bpy.context.scene.collection.children}:
    bpy.context.scene.collection.children.link(collection)
for obj in imported:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)

# Unity's space is left-handed and Y-up; Blender's is right-handed and Z-up.
#
# WHY THIS IS NOT obj.scale.y *= -1
# ----------------------------------
# A negative Y scale leaves a MIRRORING TRANSFORM on the object while its vertex
# normals and its triangle winding still describe the un-mirrored geometry.
# Blender does not carry custom normals through a mirror (the normals stay in
# object space and keep pointing the way the OBJ authored them), and it does not
# reverse face winding for a negative determinant either. So the object renders
# inside-out / mis-shaded, and the result is wrong geometry that still looks
# like a successful import -- exactly the failure this suite exists to catch.
#
# So the flip is BAKED INTO THE MESH DATA: mirror the vertices in mesh space,
# then flip the vertex normals and the polygon winding to match, and leave
# object scale at (1, 1, 1). No live negative scale remains for the next export
# to compound.
#
# Accumulation across round trips: because nothing is left as a transform, a
# re-import of the same-named object simply replaces the old object and this
# runs once on the fresh geometry. Baking is what makes the flip idempotent --
# there is no scale left to multiply by -1 a second time.
#
# EVERY mesh in the batch is flipped, not only the roots, because the flip now
# lives in mesh data rather than in an inherited root scale. An OBJ carries no
# transform rows, so Blender's importer leaves every imported object at identity
# and parenting (use_split_groups nests groups under Empties) carries no
# rotation or scale to compose against -- mirroring each mesh in its own space
# is therefore the same mirror as mirroring the batch. The old root-only
# `scale.y *= -1` could rely on inheritance to reach the children; baking
# cannot.
#
# mesh.transform() mirrors the vertex positions but NOT the custom normal layer,
# so flip_normals() is what reverses the stored normals, and Blender's own
# "flip normals" also reverses polygon winding. Both are required: one fixes
# shading, the other fixes which side is the outside.
_FLIP_Y = Matrix.Diagonal((1.0, -1.0, 1.0, 1.0))
flipped_roots = []
if CONFIG.get("flipUpAxis", True):
    for obj in imported:
        # MESH only: an ARMATURE or EMPTY has no mesh data to bake into, and
        # touching .data on it would raise.
        if obj.type != "MESH":
            continue
        obj.data.transform(_FLIP_Y)
        obj.data.flip_normals()
        obj.data.update()
        flipped_roots.append(obj.name)

for obj in imported:
    obj.select_set(True)
bpy.context.view_layer.objects.active = imported[0]

if mtl_path and os.path.exists(mtl_path):
    bpy.ops.file.make_paths_relative()

materials = sorted(
    {slot.material.name for obj in imported for slot in getattr(obj, "material_slots", []) if slot.material}
)

print(
    json.dumps(
        {
            "importedNames": [obj.name for obj in imported],
            "materialNames": materials,
            "collectionName": collection.name,
            "vertexTotal": sum(len(obj.data.vertices) for obj in imported if obj.type == "MESH"),
            # Same shape and name import_fbx.py already reports, so one caller
            # reads both routes the same way: a caller can tell "nothing was
            # flipped" from "the flip never happened".
            "flippedRoots": flipped_roots,
        }
    )
)
