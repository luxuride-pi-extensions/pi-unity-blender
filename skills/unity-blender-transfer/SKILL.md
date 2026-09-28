---
name: unity-blender-transfer
description: Use when moving geometry or materials between a live Blender session and a live Unity Editor — which format each direction uses, how to scope what travels, how to verify the result on the receiving side, and the failure modes that look like success. Read before the first transfer in a conversation.
---

# Unity <-> Blender transfers

Two applications, two bridges, one transfer tool. The direction decides almost
everything, so establish the direction before anything else.

## The formats, and why they differ

**Blender -> Unity: FBX.** Blender writes FBX natively, Unity imports it well,
and the textures are embedded — which matters because Unity's FBX importer
cannot resolve Blender-relative texture paths once the FBX lands in a different
project.

**Unity -> Blender: the SOURCE MODEL FILE, not a re-export.** When the object
traces back to a real model asset under `Assets/` (FBX, blend, obj, dae, gltf,
glb) the whole file is handed over verbatim. A file carries the rig, the
material assignment, and the animation; a re-export flattens all of that away.
`preferSourceModels` is on by default, and the OBJ+MTL path is the fallback for
objects with no file behind them.

**Why OBJ at all, then?** Unity has an FBX *importer* and no mesh *exporter* in
any package, so a Unity-origin mesh can only leave as OBJ. And Blender's OBJ
importer is native and version-stable, which is the property that matters on the
receiving side. Do not add a package to a project to change this; a hand-written
FBX exporter would be worse than the format's limits.

**What OBJ cannot carry, stated plainly:** only Kd/Ks/Ns/d/illum. Emission, rim,
matcap, outline — everything that makes a lilToon or VRCFury material look like
itself — does not survive. The export writes a `materials.json` sidecar naming
the shader and the properties it read, so the receiving side knows what was lost
instead of guessing. A transfer that "worked" with a flat grey avatar has not
preserved the look.

## Before transferring

`unity_blender_status` first, always. It reports both bridges' liveness, both
editors' presence, any lock, and a per-direction checklist. The common answers:

- A bridge that is not answering is not a bridge that will start in time.
  Starting a cold Unity Editor takes 1-3 minutes and a transfer that needs one
  will time out rather than fail fast.
- `busy: true` means another request holds the bridge. Both bridges serialize;
  a second concurrent request queues and then fails on its own timeout. Wait.
- Neither editor needs to be on PATH; detection tries the env override, the
  macOS bundle, the Hub layout, and flatpak. A false "not installed" was a
  `commandExists("blender")` bug, now fixed — trust the tool over your shell.

`unity_source_models { mode: "find" }` before a Unity -> Blender transfer.
It reports which files would travel, which objects, vertex and bone totals, and
which objects are **unhandoffable**. Unity's built-in primitives (a sphere, an
arrow, a gizmo target) report `Library/unity default resources`, which no other
application can open. They are not lost files and nothing went wrong; say so
rather than re-importing to "fix" it.

## Scoping

`objectNames` is a list of GameObject names. An empty list means every scene
root, which is almost never what anyone wants — a mistyped key is rejected by
the tool's key validation rather than silently widening the transfer, but an
intentionally empty list really does take the whole scene.

Names must be unambiguous. Two avatars in a scene (Chiffon and Chiffon Quest
Friendly) means a bare `Head` is an error, not a coin flip. Use a full path or
an avatar-scoped path.

The receiving prefab is **not** added to the scene unless asked. Import creates
the prefab; instantiate it as a separate deliberate step, so a transfer never
silently changes what the user is looking at.

## On the Blender side

Imported objects land in one named collection (`Pi_Imported` by default) and
nothing else is touched. Blender names objects after the FBX's own nodes, so
the names in the report may not match the names in the file — that is correct
behaviour, not a mismatch. Trust the count.

A `g` line in an OBJ names a VERTEX GROUP, not an object; only an `o` line
names an object. The exporter writes `o`, and a `g`-only OBJ imports as a single
object named after the file, which is how `transfer` / `transfer.001` names
appear when something upstream goes wrong.

## After transferring

Verify on the receiving side, not from the report:

- Blender: `blender_scene_info` with narrow categories. For a rig, check the
  ARMATURE objects' bone counts — that is the only evidence the skeleton came
  across, and a source-model handoff that silently lost the rig reports
  success.
- Unity: `unity_scene_info` for the prefab's contents, and `unity_render` or
  `unity_capture_view` for how it actually looks. A material that lost its
  shader shows up here, not in the transfer result.

Then clean up. The Blender-side collection is real scene content; leaving a
`Pi_Imported` collection full of stale duplicates makes the next transfer's
result unreadable. Delete it, purge the orphaned data, and say that you did.

## Things that look like success and are not

- **A material rendering white.** A lilToon material in a built-in-pipeline
  project assigns, passes every property check, and renders pure white with no
  error. Check the render pipeline before suspecting the transfer.
- **Vertex count zero in a result field.** The export summary carries
  `vertexTotal`; a zero means the field was dropped, not that the mesh was
  empty. Re-verify on the receiving side instead of trusting the report.
- **A count that matches but a rig that did not come across.** An FBX carries
  its bones; an OBJ never does. If the direction was OBJ, no armature is
  expected, and its absence is not a bug.
- **A dead heartbeat but a running Editor.** The heartbeat can be frozen while
  the process is gone, and a *fresh* heartbeat on a long-running Editor is not
  evidence that its bridge code matches the current plugin source — the process
  loaded the file when it started. Editing a bridge's Python does not hot-reload.

## Staging

Intermediates (FBX, OBJ, MTL, textures) are staged in pi's cache directory,
never inside a project or a `.blend`. A user who aborts a transfer must not
find junk in `Assets/`. The staging path is in `unity_blender_status`; the
`unity-blender` staging directory also keeps a `.transfers.log` of every run.
