# pi-unity-blender

The binder: moves meshes and materials between a **live Blender session** and a
**live Unity Editor**.

MIT.

---

## Tools

The binder registers two tools; detail, transfer mechanics and the failure
modes live in [docs/DESIGN.md](docs/DESIGN.md).

| Tool | What it does |
|---|---|
| `unity_blender_status` | report both bridges: alive/busy/locked on each side |
| `unity_blender_transfer` | move geometry/materials between live Blender and Unity (one direction per call) |

The `/unity-blender` command engages the cross-application manager
(`unity-blender-manager`), which routes to per-side skills and to
`unity_blender_transfer`.

---

## Install

The released package installs with pi itself:

```bash
pi install npm:@luxuride-pi/unity-blender
```

For development from a clone (symlink install):

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/unity-blender
```

Same two caveats as the other extensions: `node_modules/typebox` symlinks into
pi's own install, and agent templates must be installed from the **binder's**
repo — not pi-unity-vrchat's installer, which would race over the same file.

```bash
node scripts/install-agents.mjs            # dry run: print resolved paths
node scripts/install-agents.mjs --write    # install into $PI_AGENT_DIR/agents
```

`unity-blender-manager` is the TOP-LEVEL agent entered from `/unity-blender`,
for work in a live Blender session, a live Unity Editor, or both. It is a sibling
of `unity-manager` (`/unity`) and `blender-manager` (`/blender`), not their
parent: each of the three is spawned straight from its own command, and each one
then owns its own subagents. It holds all three extensions on its `extensions:`
line, and it owns both build loops as well as what crosses between them. All three paths are required — a foreground
child does not load ambient parent extensions, so a tool named in `tools:` that
no listed extension registers is requested and never provided.

What is merged here is the CROSS-APPLICATION role, not the per-side ones:
`unity-manager` and `blender-manager` still exist as the top-level agents of
their own side, this agent's `allowedAgents` is the flat union of all three
families, and this one is the agent to reach when a task touches both
applications or moves geometry between them. The prompt deliberately contains
no build procedure. It routes to the
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

## Releases

Every release is both a **git tag** and an npm package. The package publishes
as `@luxuride-pi/unity-blender` from the release workflow via npm trusted publishing (OIDC from
GitHub Actions — no publish token exists anywhere).

pi can also install this extension from the **clone**: `installGit()` runs
`git clone`, an optional `git checkout <ref>`, then
`npm install --legacy-peer-deps` inside it, and pi loads the extension's
TypeScript straight from source through jiti. So a tag *is* the artifact for a
git install — there is no build step and nothing to compile.

### Install a release

```bash
pi install npm:@luxuride-pi/unity-blender@^<version>
# or, from the clone:
pi install git:github.com/luxuride-pi-extensions/pi-unity-blender@v<version>
```

The `@ref` is what pins the version; without it pi tracks the default branch, so
an unpinned spec is not a release, it is a moving target.

### Cut a release

1. Bump `version` in `package.json` and commit that on its own.
2. Tag the commit that contains the bump — the tag and the version must agree:
   ```bash
   git tag v<version> && git push origin master --tags
   ```
3. `.github/workflows/release.yml` packs the tarball, checks it, and publishes
   the release with generated notes.

Step 2 is the one that is easy to get wrong, so the workflow refuses to guess:
it fails when the tag is not on the commit being released, and again when the
tag does not match `package.json`'s `version`. Bump the version *before*
tagging; the tag is not the place to bump.

The `npm pack --dry-run` check in the release workflow is deliberately a copy of
what `pi-manager-core`'s `test/package-contents.mjs` proves on every CI run. A
release workflow that borrowed the check from another repository would depend on
that repository being checked out at the right ref, which is a moving part a
release should not have.
