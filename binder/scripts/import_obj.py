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

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]

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
# reason to export by name at all. Ask for group naming explicitly.
#
# Keyword names have moved between Blender versions, so filter against the real
# RNA instead of trusting a fixed set.
_IMPORT_KWARGS = {
    "filepath": obj_path,
    "forward_axis": "NEGATIVE_Z",
    "up_axis": "Y",
}


def _importer_rna():
    for module_name, operator_name in (("wm", "obj_import"), ("import_scene", "obj")):
        module = getattr(bpy.ops, module_name, None)
        operator = getattr(module, operator_name, None) if module else None
        if operator is not None:
            return operator.get_rna_type()
    return None


def _supported_kwargs(desired):
    """Keep only the keywords this Blender's importer really accepts."""
    rna = _importer_rna()
    if rna is None:
        raise RuntimeError("This Blender build exposes no OBJ importer (tried wm.obj_import and import_scene.obj).")
    supported = {prop.identifier for prop in rna.properties}
    dropped = sorted(set(desired) - supported)
    if dropped:
        print(f"NOTE: this Blender's OBJ importer does not support {dropped}; skipped")
    return {key: value for key, value in desired.items() if key in supported}


_kwargs = _supported_kwargs(_IMPORT_KWARGS)
try:
    bpy.ops.wm.obj_import(**_kwargs)
except AttributeError:
    bpy.ops.import_scene.obj(**_kwargs)

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

# Unity uses a left-handed, Y-up space; the importer axes above handle the
# handedness, but a negative Y scale on the whole batch reads more naturally in
# Blender than mirroring every object.
if CONFIG.get("flipUpAxis", True):
    for obj in imported:
        if obj.parent is None:
            obj.scale.y *= -1

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
        }
    )
)
