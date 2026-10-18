# pi-unity-blender

The binder: moves meshes and materials between a **live Blender session** and a
**live Unity Editor**.

## Tools

The binder registers two tools; detail, transfer mechanics and the failure
modes live in [docs/DESIGN.md](docs/DESIGN.md).

| Tool | What it does |
|---|---|
| `unity_blender_status` | report both bridges: alive/busy/locked on each side |
| `unity_blender_transfer` | move geometry/materials between live Blender and Unity (one direction per call) |

The `/unity-blender` command engages the cross-application manager
(`unity-blender-manager`), which routes to per-side skills and to
`unity_blender_transfer`. It is a sibling top-level manager, not a parent of
the per-side managers: it holds all three extensions on its `extensions:`
line, owns both build loops as well as what crosses between them, and is the
manager to reach when a task touches both applications or moves geometry
between them. The prompt deliberately contains no build procedure — it routes
to the per-side skills (`unity-live-state`, `blender-modules`, `unity-csharp`,
…) and to the `unity-blender-transfer` skill, which carry the loops and the
failure modes. What stays in the prompt is what no single skill can own: the
two-applications-at-once rules — one `unity_blender_status` first, one
mutating operation at a time across BOTH bridges, a transfer is a step inside
a build rather than a separate task, and the manager never authors or eyeballs
anything.

The `unity-blender-transfer` skill ships in `skills/` and is published through
a `resources_discover` hook added to `index.ts`. Without that hook the
directory is invisible to pi: the skill would exist on disk and never load.

## Install

```bash
pi install npm:@luxuride-pi/unity-blender
```

The `unity-blender-manager` agent must also exist in `$PI_AGENT_DIR/agents`,
and it needs both side extensions installed for its `extensions:` line. The
binder ships its agent templates, so install them once from the installed
copy — from the binder's repo, not another extension's installer, which would
race over the same destination file:

```bash
node scripts/install-agents.mjs            # dry run: print resolved paths
node scripts/install-agents.mjs --write    # install into $PI_AGENT_DIR/agents
```

Transfer mechanics, staging, editor detection and per-tool behaviour:
[docs/DESIGN.md](docs/DESIGN.md).

## Releases

Every release is both a **git tag** and an npm package. The package publishes
as `@luxuride-pi/unity-blender` from the release workflow via npm trusted
publishing (OIDC from GitHub Actions — no publish token exists anywhere).

pi can also install this extension from a **git ref**: pi clones, checks out
the ref, runs `npm install --legacy-peer-deps`, and loads the extension's
TypeScript straight from source — so a tag *is* the artifact; there is no
build step and nothing to compile.

### Install a release

```bash
pi install npm:@luxuride-pi/unity-blender@^<version>
# or, pinned to a git tag:
pi install git:github.com/luxuride-pi-extensions/pi-unity-blender@v<version>
```

### Cut a release

1. Bump `version` in `package.json` and commit that on its own.
2. Tag the commit that contains the bump — the tag and the version must agree:
   ```bash
   git tag v<version> && git push origin master --tags
   ```
3. `.github/workflows/release.yml` packs the tarball, checks it, and publishes
   the release with generated notes.

The workflow refuses to guess: it fails when the tag is not on the commit being
released, and again when the tag does not match `package.json`'s `version`.
Bump the version *before* tagging; the tag is not the place to bump.

## License

MIT
