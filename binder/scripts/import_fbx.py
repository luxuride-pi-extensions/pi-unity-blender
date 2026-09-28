"""Unity -> Blender import of SOURCE MODEL files, executed inside the live
Blender session.

Run by the pi-unity-blender binder. The configuration blob is interpolated at
transfer time (see binder/script-template.ts).

WHY SOURCE MODELS INSTEAD OF AN OBJ RE-EXPORT
---------------------------------------------
An imported mesh in Unity almost always came from a model file that is still on
disk under Assets/. Handing that file to Blender beats re-exporting it:

  * Blender imports FBX natively, with the rig, the shape keys and the material
    description Unity itself already read.
  * Nothing is lost translating it a second time, which is exactly what OBJ+MTL
    does -- MTL can only express Kd/Ks/Ns/d/illum.

The scope is deliberately WHOLE FILE. An FBX carries no sub-mesh selection, so
asking for one body part brings the whole file; the binder reports which
sub-meshes were asked for and which arrived, and the user deletes in Blender what
they did not want.

Skins and the coordinate handedness
-----------------------------------
FBX is authored Y-up like Unity, so the importer defaults line the two up
without a scale hack -- unlike the OBJ path, which needs a negative Y scale to
sit sensibly in Blender's Z-up space. That difference is reported, because
"imported flipped" and "imported upright" must not be confused later.
"""

import json
import os

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]

# pi-lens-ignore: ast-grep:unchecked-throwing-call-python
CONFIG = json.loads(r"""__PI_BINDER_CONFIG__""")

fbx_paths = CONFIG.get("fbxPaths") or []
collection_name = CONFIG.get("collectionName") or "Pi_Imported"
flip_up_axis = CONFIG.get("flipUpAxis", False)

if not fbx_paths:
    raise RuntimeError("import_fbx was called with no fbxPaths; there is nothing to import.")

# Record the pre-existing objects so "imported" means imported BY THIS RUN.
before = set(bpy.data.objects)
bpy.ops.object.select_all(action="DESELECT")

IMPORT_KWARGS = {
    "use_manual_orientation": bool(flip_up_axis),
    "global_scale": 1.0,
    "use_custom_normals": True,
    "use_custom_props": False,
    "add_leaf_bones": False,
    "primary_bone_axis": "Y",
    "secondary_bone_axis": "X",
}


def _importer_rna():
    """Locate the FBX importer, filtering to the one this Blender actually has.

    Blender has carried both `bpy.ops.import_scene.fbx` (the C++ one, default in
    every release) and `bpy.ops.wm.fbx_import` (a newer Python rewrite) at
    different times, and their keyword sets differ. Probing the live RNA is the
    only way to avoid "keyword unrecognized" at run time -- the same lesson as
    the FBX exporter in export_fbx.py.
    """
    for module_name, operator_name in (("import_scene", "fbx"), ("wm", "fbx_import")):
        module = getattr(bpy.ops, module_name, None)
        operator = getattr(module, operator_name, None) if module else None
        if operator is not None:
            return operator, operator.get_rna_type()
    return None, None


operator, rna = _importer_rna()
if operator is None or rna is None:
    raise RuntimeError("This Blender build exposes no FBX importer (tried import_scene.fbx and wm.fbx_import).")

supported = {prop.identifier for prop in rna.properties}
kwargs = {key: value for key, value in IMPORT_KWARGS.items() if key in supported}
dropped = sorted(set(IMPORT_KWARGS) - set(kwargs))
if dropped:
    print(f"NOTE: this Blender's FBX importer does not support {dropped}; skipped")

imported_files = []
for fbx_path in fbx_paths:
    if not os.path.exists(fbx_path):
        raise RuntimeError(f"Unity reported a successful export but no model file exists at {fbx_path}")
    operator(filepath=fbx_path, **kwargs)
    imported_files.append(os.path.basename(fbx_path))

imported = [obj for obj in bpy.data.objects if obj not in before]
if not imported:
    raise RuntimeError("The FBX import produced no objects. The file may be empty or malformed.")

# Group under one collection so a later transfer can remove or re-export the
# whole batch, and so deleting what you did not ask for is one click on a
# collection rather than hunting objects.
collection = bpy.data.collections.get(collection_name) or bpy.data.collections.new(collection_name)
if collection.name not in {child.name for child in bpy.context.scene.collection.children}:
    # The scene's master collection holds child collections, not objects, so the
    # link goes through .children. Calling scene.collection.link() raises
    # AttributeError: 'Collection' object has no attribute 'link'.
    bpy.context.scene.collection.children.link(collection)
for obj in imported:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)

materials = sorted(
    {slot.material.name for obj in imported for slot in getattr(obj, "material_slots", []) if slot.material}
)

# FBX arrives Y-up, matching Unity, so the importer's own axis handling lines it
# up. The OBJ path needed a negative Y scale instead; applying that here as well
# would double-correct it and tip the model on its side.
flipped_roots = []
if flip_up_axis:
    roots = {obj for obj in imported if obj.parent is None}
    for root in roots:
        root.scale.y = -root.scale.y
        flipped_roots.append(root.name)

print(
    json.dumps(
        {
            "importedNames": [obj.name for obj in imported],
            "materialNames": materials,
            "collectionName": collection.name,
            "vertexTotal": sum(len(obj.data.vertices) for obj in imported if obj.type == "MESH"),
            "importedFiles": imported_files,
            "armatures": [obj.name for obj in imported if obj.type == "ARMATURE"],
            "flippedRoots": flipped_roots,
        }
    )
)
