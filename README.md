# pi-unity-blender

The binder: moves meshes and materials between a **live Blender session** and a
**live Unity Editor**.

MIT.

---

## What it needs

Both applications open, with their pi bridges loaded. That means:

- `pi-vibe-blender` installed and the `.blend` open in Blender
- `pi-vibe-unity` installed and a project open in Unity

Neither is a dependency of this extension. Call `unity_blender_status` first —
it reports every unmet precondition at once, so you learn about the missing
Editor *now* rather than after a two-minute cold start.

## Install

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/unity-blender
```

Same two caveats as the other extensions: `node_modules/typebox` symlinks into
pi's own install, and agent templates must be installed from the **binder's**
repo — not pi-vibe-unity's installer, which would race over the same file.

```bash
node scripts/install-agents.mjs            # dry run: print resolved paths
node scripts/install-agents.mjs --write    # install into $PI_AGENT_DIR/agents
```

`unity-blender-manager` is the ROOT agent for work in a live Blender session, a
live Unity Editor, or both: it is not a Unity or a Blender subagent, it holds
all three extensions on its `extensions:` line, and it owns both build loops as
well as what crosses between them. All three paths are required — a foreground
child does not load ambient parent extensions, so a tool named in `tools:` that
no listed extension registers is requested and never provided.

It replaces `unity-manager` and `blender-manager`, which are retired: those two
roles are now one agent, and its `allowedAgents` is the flat union of their
families. The prompt deliberately contains no build procedure. It routes to the
per-side skills (`unity-live-state`, `blender-modules`, `unity-csharp`, …) and
to `unity-blender-transfer`, which carry the loops and the failure modes. A
copied loop goes stale the moment either extension is upgraded, and a stale
loop is worse than none because it looks authoritative. What stays in the
prompt is what no single skill can own: the two-applications-at-once rules —
one `unity_blender_status` first, one mutating operation at a time across BOTH
bridges, a transfer is a step inside a build rather than a separate task, and
the manager never authors or eyeballs anything.

The `unity-blender-transfer` skill ships in `skills/` and is published through a
`resources_discover` hook added to `index.ts`. Without that hook the directory
is invisible to pi: the skill would exist on disk and never load.

## Usage

```
/unity-blender move the selected meshes from Blender into Assets/Art
```

or drive the tools directly:

- `unity_blender_transfer` — do the transfer
- `unity_blender_status` — who is alive, who is locked, what is missing

---

## Why it doesn't import the other extensions

The only thing Blender and Unity have in common here is the bridge wire
protocol: a request JSON appears in a directory, the application writes a
response JSON back. So `binder/bridge.ts` speaks that protocol directly and is
the single client for **both** bridges.

Importing `pi-vibe-unity`'s and `pi-vibe-blender`'s internals would couple this
extension to their request shapes, their environment variables, and their
install layout — each of which can change or be removed independently. The
coupling buys nothing; the protocol is the contract.

## Why the format is asymmetric

This follows from the applications, not from preference:

| Direction | Format | Why |
| --- | --- | --- |
| Blender → Unity | **FBX** | Both apps read FBX; Blender *writes* it natively and Unity imports it well. Textures are **embedded** (`embed_textures=True`) because Unity's importer cannot resolve Blender-relative texture paths. |
| Unity → Blender | **The source model file**, falling back to OBJ + MTL | A file carries the rig, the material assignment and the animation; a re-export flattens all of that away. `preferSourceModels` is on by default, and OBJ is the fallback for objects with no file behind them — Unity has **no built-in mesh exporter at all**, so the bridge writes OBJ by hand (`ExportObj` in `PiUnityBridge.cs`). |

So a single Unity → Blender call often takes **both** routes at once: every
object with a source file travels as that file, and everything else is exported
separately as OBJ. The result reports it (`usedBothRoutes`), and the
consequences are per-object — some objects arrive with an armature and others
cannot, because an OBJ never carries bones. The axis handling differs by route
too: an FBX import needs no fix (FBX is Y-up like Unity), while an OBJ import
gets a negative Y scale. See the skill for the full per-object consequences.

---

## What actually survives the trip

**Crosses:** mesh geometry, UVs, material slots, base texture images, object
naming and hierarchy.

**Flattened:** material *graphs*. Blender's node trees and Unity's shader graphs
become the property set the exchange format can carry — base colour, metallic,
roughness, emission. Layered, procedural, or custom-node setups lose their
structure.

**Does not cross:** lights, cameras, animation rigs, physics, scripts, scenes.

Always verify materials on the receiving side. `unity_blender_transfer` returns a
`notes` array saying so in as many words; the counts in the result are the
format's opinion of what fit, not proof it looks right.

## Staging

Intermediate files live in `$XDG_CACHE_HOME/unity-blender/staging/<mkdtemp>`,
never inside a project or a `.blend` directory, and every staging dir is
appended to `.transfers.log`. A failed transfer leaves nothing in your work.

Override with `PI_UNITY_BLENDER_STAGING_DIR`. Related: `PI_UNITY_BLENDER_HEARTBEAT_STALE_MS`
(default `10000`) sets how old a bridge heartbeat may be before a side counts as dead.

## The Blender script gets its config interpolated

The Blender bridge's `execute-python` request has **no custom-argument
channel** — it passes only `OUTPUT_BLEND_PATH`, `WORKSPACE_PATH`, and
`ITERATION_PATH` as globals, then execs the file at `userScriptPath`. So the
transfer's settings are written *into* the staged script as a JSON literal
replacing a `__PI_BINDER_CONFIG__` placeholder, and the script is read from disk
fresh each run. JSON is valid Python for every value passed here, and it escapes
names correctly — which matters, because object and texture names come from the
user's scene.

`binder/scripts/export_fbx.py` and `binder/scripts/import_obj.py` are therefore
real, lintable `.py` files rather than template strings.

## Editor detection

Neither editor is on `PATH` on this machine, which is the normal case and the
reason a bare `commandExists("blender")` probe is not used. Each editor is
located the same way its own extension locates it for launching:

| Editor | Routes probed, in order |
| --- | --- |
| Blender | `$BLENDER_PATH` → macOS app bundle → `flatpak info --show-ref org.blender.Blender` → `PATH` |
| Unity | `$UNITY_PATH` → macOS Hub → `$UNITY_HUB_PATH/Editor/<version>/Editor/Unity`, newest first → `PATH` |

`unity_blender_status` reports which route matched, so a "found" you did not
expect is explainable. A **not found** result is informational only: both legs
run inside an already-open application, so a detected binary matters just for
headless or CLI use. Detection never launches anything.

## Development

```bash
./node_modules/typescript/bin/tsc --noEmit   # NOT `npx tsc` — it is a false pass
```

`npx tsc` downloads a decoy `tsc@2.0.4` and reports success without checking
anything. Always use the local binary from `node_modules`.

Host paths are resolved rather than hardcoded, so this repo works on another
machine. Every variable the code reads, in the order it matters:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BLENDER_PATH` | auto | Blender binary. Probed first when detecting the editor. |
| `UNITY_PATH` | auto | Unity Editor binary. **Whitespace-split into argv.** |
| `UNITY_HUB_PATH` | `~/Unity/Hub` | Hub install root, searched newest-version-first. |
| `PI_BLENDER_BRIDGE_DIR` | `$XDG_CACHE_HOME/vibe-blender/bridge` | Blender request/response queue. |
| `PI_UNITY_BRIDGE_DIR` | `$XDG_CACHE_HOME/vibe-unity/bridge` | Unity request/response queue. |
| `PI_UNITY_BLENDER_STAGING_DIR` | `$XDG_CACHE_HOME/unity-blender/staging` | Transfer staging. **Keep this in the cache** — the Blender flatpak sandbox cannot read `/tmp`. |
| `PI_UNITY_BLENDER_HEARTBEAT_STALE_MS` | `10000` | How old a bridge heartbeat may be before the bridge counts as dead. |

Both bridge directories can point at the same place, but they are independent
queues: the binder talks to whichever editor is open and reports the other as
dead. That is a correct report, not a bug.

## Known limits

- **Neither leg has been run end-to-end against live applications.** Both
  editors are present on this machine (Blender as the `org.blender.Blender`
  5.2 flatpak, Unity 2022.3.22f1 in the Hub), but both must be *open with their
  bridge loaded* for a real test, and that has not been done. The Blender →
  Unity leg is the more likely of the two to need adjustment, since it is the
  one whose export has never executed.
- **A dirty `.blend` exports from disk.** Only what is saved crosses; the
  result says so in `notes` rather than silently exporting stale geometry.
- **No `.blend` open means no transfer from that side.** The binder exports
  *through the live session*, so an unsaved document has no path to hand over.
- **Axis flip on the way back.** Unity is Y-up, Blender Z-up, so the OBJ import
  negates Y by default (`flipUpAxis: true`). Passing it through twice
  inverts handedness — the result warns about this.
- **No material verification.** Nothing in this extension opens a render to
  confirm the materials landed. That is a deliberate scope cut, not an
  oversight.
