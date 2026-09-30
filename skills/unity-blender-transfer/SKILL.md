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
- A lock reported with `unreadable: true` is still held — the file is there, its
  contents just did not parse, which is what a process killed mid-transfer
  leaves behind. Treat it as busy, not as a clean slate: it is reclaimed
  automatically once it passes the stale threshold.
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

## Arriving on the Unity side

The transfer ends at a **prefab asset** under `destination`, deliberately NOT in
the scene, so importing never changes what the user is looking at. Composition is
the next, explicit step:

- `unity_prefab_info { prefabPath }` — what the prefab contains: children,
  materials, bounds. Read-only; instantiates nothing. Do this before placing, so
  a wrong asset is discovered before it is in the scene.
- `unity_instantiate_prefab { prefabPath, position, rotation, parent }` — place
  it in one call. Returns the instance's scene **path** and its child inventory.

Use the returned `path` for anything afterwards. A prefab's children repeat their
names in every instance, so `gameObject: "Leg"` is refused as ambiguous the
moment the asset is placed twice — a scene path (`"Chair (2)/Leg"`) always
resolves. Do not place with `Object.Instantiate` in a snippet: it produces a
detached copy that never follows the asset.

Pass `name` on every transfer. The name is what the FBX, the prefab and every
later reference are built from, and a second transfer reusing an existing name is
now refused instead of overwriting the first model — which is correct, but reads
as a failure if you did not expect it. Distinct `destination` per model works
too.

## On the Blender side

Imported objects land in one named collection (`Pi_Imported` by default) and
nothing else is touched. Blender names objects after the FBX's own nodes, so
the names in the report may not match the names in the file — that is correct
behaviour, not a mismatch. Trust the count.

A `g` line in an OBJ names a VERTEX GROUP, not an object; only an `o` line
names an object. The exporter writes `o`, and a `g`-only OBJ imports as a single
object named after the file, which is how `transfer` / `transfer.001` names
appear when something upstream goes wrong.

## One Blender, shared by the whole tree

A transfer runs *through* the live session, so it is bound to that session's one
Blender — not a Blender of its own. The root pi process owns the window; every
manager, worker and critic in the session's tree inherits the same bridge
instance id and therefore the same directory, and a cross-process `launch.claim`
in that directory stops two processes from racing to open a second window. You
do not need to arrange any of that, and you cannot make it per-subagent.

The consequence for you is ordering, not identity. A transfer is a mutating
request against a bridge that serializes: never overlap one with a module run or
another transfer. A fan-out of workers is fine (they only author script files);
the runs and any transfer go one at a time.

`unity_blender_status` reports the owner as `blenderInstance`. `isRoot: false`
is normal in a subagent. The signal that something is actually wrong is
`instanceId !== rootInstanceId` — this process is addressing a different Blender
than the session's owner — and `pinned: true`, meaning the user set
`PI_BLENDER_BRIDGE_DIR` by hand, which switches the per-instance scheme off and
makes one directory shared deliberately.

## One transfer, two routes — know which you got

A Unity -> Blender move is rarely one route. Every object with a source file
travels as that file; everything else is exported separately as OBJ. A single
call therefore often produces BOTH, and the result says so: `usedBothRoutes:
true`, with the OBJ'd object names in the notes. Read the notes rather than the
summary line, because the summary's `vertexTotal` and `materialNames` aggregate
across both routes and hide which object lost which treatment.

The consequences are per-object, and that is what the aggregate hides:

- A source-file object keeps its rig, its material assignment and its
  animation. An OBJ'd object has Kd/Ks/Ns only. So after a mixed transfer it is
  normal — expected, not broken — that some objects have an ARMATURE in
  `blender_scene_info` and others do not.
- An FBX import needs no axis fix: FBX is Y-up like Unity, so Blender's
  importer lines the two up on its own and the transfer says it was imported
  "at its authored orientation". An OBJ import is given a **negative Y scale**
  instead. That asymmetry matters on a round trip: send the OBJ'd object back
  and the importer restores the handedness, so it is restored once, not
  doubled. If an object comes back mirrored or lying on its side, this
  asymmetry is the first thing to check, not the exporter.

Ambiguity is reported rather than resolved. A GameObject name shared by several
objects cannot be exported by name — the OBJ exporter takes one object per name
— so those names come back in `ambiguousObjectNames` with their counts
(`Head (x5)`) and transfer NOTHING by name, while being counted in the request.
The fix is to give the specific object its own name or select it alone; do not
retry the same names. `unhandoffableObjects` is the other bucket: no file on
disk at all.

## A transfer is a step inside a build, not a separate task

Send when the sending side is FINISHED, after its own critic has passed. A
model still being revised crosses the boundary, comes back needing a second fix
loop, and the far side's critic scores a defect the near side already knew
about — while neither side can see the other's history. One direction, one
handover, per finished asset.

Then verify with the RECEIVING side's critic, on a render of what actually
landed. The transfer's own numbers prove that a script ran; they cannot see that
a material arrived flat. That render is a subagent's job, never yours.

## After transferring

Verify on the receiving side, not from the report:

- Blender: `blender_scene_info` with narrow categories. For a rig, check the
  ARMATURE objects' bone counts — that is the only evidence the skeleton came
  across, and a source-model handoff that silently lost the rig reports
  success.
- Unity: `unity_prefab_info` for the prefab's contents, and `unity_render` or
  `unity_capture_view` for how it actually looks. A material that lost its
  shader shows up here, not in the transfer result. Note that
  `unity_scene_info { categories: ["materials"] }` lists standalone `.mat` files
  only and CANNOT see a material embedded in the FBX — which is where a
  transferred model's materials live, so an empty list there is not evidence they
  were lost. `unity_prefab_info`'s `materials`, or `embeddedMaterials`, is where
  they are.

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
- **A transfer that carried the wrong thing.** Every check on this page passes
  and the result is still wrong, because nothing in the wire format records what
  the model is *supposed* to be. See the reference section above.

## References, and the failure that survives a clean transfer

If a transfer is driven by a reference image, spawn
`unity-blender-reference-describer` first and hand its `Suggested caption` and
`Applies to:` down to the side that builds. You have no image input either, and
this skill's own failure mode makes a wrong caption unusually dangerous: a
transfer has no opinion about whether the thing it carried was the thing you
wanted. Geometry, UVs, and material slots all arrive, the counts check out, the
prefab imports, and the only defect — the subject — crossed the boundary intact
and undetected. It then reads as success to the worker, the critic, and the
manager alike, because every one of them believes the same wrong sentence.

So when a reference governs the transfer, `Applies to:` decides which side
builds: `Blender` means model it there and send it over, `Unity` means the mesh
already exists in the project and travels inward, `both` means the shape is
shared but the material treatment is not — a material graph is flattened in
either direction, so the receiving side still needs its own verification.

## Staging

Intermediates (FBX, OBJ, MTL, textures) are staged in pi's cache directory,
never inside a project or a `.blend`. A user who aborts a transfer must not
find junk in `Assets/`. The staging path is in `unity_blender_status`; the
`unity-blender` staging directory also keeps a `.transfers.log` of every run.
