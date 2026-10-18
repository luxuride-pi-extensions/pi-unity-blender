/**
 * What the extension hands to pi, and where it decides to put things.
 *
 * Neither had a test, and both fail silently. A tool that registers under the
 * wrong name is simply absent -- pi shows no error, the manager's brief names it
 * anyway, and the transfer the user asked for never happens. A bridge dir
 * resolved one level too high reports the live Blender dead while it is up and
 * serving that very session, which is what the comment on getBlenderBridgeDir
 * in config.ts describes having actually happened.
 *
 * Registration is tested against the real default export with a recording
 * ExtensionAPI double, not by reading index.ts: the tool count, the names, the
 * parameters and the execute signature are all facts pi depends on, and a
 * rename that leaves a README row behind is invisible without this.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { loadTs } from "./paths.mjs";

// mkdir first: mkdtemp creates a directory INSIDE the prefix it is given and
// will not create a missing parent. This fixture is deliberately under the CACHE
// rather than tmpdir for the flatpak reason binder-scripts.test.mjs explains,
// and on a fresh runner ~/.cache does not exist yet -- which made this the whole
// file's failure, with zero checks run:
// `ENOENT: no such file or directory, mkdtemp
// '/home/runner/.cache/pi-binder-config-XXXXXX'`.
mkdirSync(join(homedir(), ".cache"), { recursive: true });
const WORK = mkdtempSync(join(homedir(), ".cache", "pi-binder-config-"));
after(() => rmSync(WORK, { recursive: true, force: true }));

/**
 * A recording ExtensionAPI. Only the members index.ts actually calls are
 * implemented; anything else throws by being absent, so a new hook has to be
 * added here deliberately rather than being silently ignored.
 */
function recordingPi() {
	const tools = new Map();
	const commands = new Map();
	const events = new Map();
	return {
		tools,
		commands,
		events,
		api: {
			registerTool(tool) {
				assert.ok(!tools.has(tool.name), `tool ${tool.name} is registered twice`);
				tools.set(tool.name, tool);
			},
			registerCommand(command) {
				commands.set(command.name, command);
			},
			on(event, handler) {
				events.set(event, handler);
			},
		},
	};
}

describe("the extension's registration", () => {
	test("registers exactly the two tools the README documents, with a schema each", async () => {
		const { default: unityBlender } = await loadTs("index.ts");
		const recorder = recordingPi();
		unityBlender(recorder.api);

		assert.deepEqual(
			[...recorder.tools.keys()].sort(),
			["unity_blender_status", "unity_blender_transfer"],
			"the registered tool set changed; the README table and the manager prompt name these two",
		);
		for (const tool of recorder.tools.values()) {
			assert.ok(tool.label, `${tool.name} has no label`);
			assert.ok(
				tool.description.length > 120,
				`${tool.name}'s description is too short to route on`,
			);
			assert.equal(typeof tool.execute, "function", `${tool.name} has no execute`);
			assert.equal(tool.execute.length, 5, `${tool.name}'s execute arity changed`);
		}
	});

	test("the transfer tool asks for the parameters the transfer actually needs", async () => {
		const { default: unityBlender } = await loadTs("index.ts");
		const recorder = recordingPi();
		unityBlender(recorder.api);

		const schema = recorder.tools.get("unity_blender_transfer").parameters;
		const properties = schema.properties ?? {};
		assert.deepEqual(
			properties.direction?.anyOf?.map((s) => s.const) ?? [properties.direction?.const],
			["blender-to-unity", "unity-to-blender"],
			"the direction union changed and a caller can no longer pick a leg",
		);
		// These are the optionals that decide what crosses, so a rename here is a
		// silent behaviour change for every caller.
		for (const name of ["objectNames", "saveAfter", "collectionName", "preferSourceModels"]) {
			assert.ok(properties[name], `the transfer tool no longer accepts ${name}`);
		}
		// Not required: omitting them is the documented default behaviour.
		assert.equal(schema.required?.length, 1, "only direction should be required");
	});

	test("a registered tool is reachable by the name the manager prompt uses", async () => {
		// The prompt is the only thing that tells a manager which tool to call,
		// and it is a separate file in a separate repo on the Unity side, so the
		// join between the two is the part most likely to rot.
		const { default: unityBlender } = await loadTs("index.ts");
		const recorder = recordingPi();
		unityBlender(recorder.api);

		const prompt = readFileSync(join(import.meta.dirname, "..", "agents", "unity-blender-manager.md"), "utf8");
		const named = [...prompt.matchAll(/\bunity_blender_[a-z_]+/g)].map((m) => m[0]);
		assert.ok(named.length > 0, "the manager prompt names no tool at all");
		for (const name of new Set(named)) {
			assert.ok(recorder.tools.has(name), `the manager prompt names ${name}, which is not registered`);
		}
	});
});

describe("config resolution", () => {
	/**
	 * config.ts publishes its instance ids into process.env at MODULE LOAD, so
	 * each case needs a process that has not loaded it yet. In-process it would
	 * be the FIRST case's environment answering every question after it, which
	 * is exactly the kind of green that means nothing.
	 *
	 * The child loads the real module through jiti and evaluates `body` with
	 * `c` bound to it, so what runs under test is the shipped file rather than a
	 * transcription of its rules.
	 */
	function configIn(env, body) {
		const script = `
import { loadTs } from ${JSON.stringify(join(import.meta.dirname, "paths.mjs"))};
const c = await loadTs("config.ts");
process.stdout.write("RESULT:" + JSON.stringify(await (async () => (${body}))()));
`;
		const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			// The parent's own ids are cleared, or the child would inherit the
			// parent pi session's Blender and answer as that instance.
			env: { ...process.env, PI_BLENDER_INSTANCE_ID: "", PI_UB_ROOT_INSTANCE_ID: "", ...env },
		});
		const marker = out.lastIndexOf("RESULT:");
		assert.ok(marker >= 0, `no result from the child:\n${out.slice(-2000)}`);
		return JSON.parse(out.slice(marker + "RESULT:".length));
	}

	test("the Blender bridge dir is the instance subdir, not the root", () => {
		assert.deepEqual(
			configIn(
				{
					PI_BLENDER_BRIDGE_DIR: "",
					PI_BLENDER_INSTANCE_ID: "abc123",
					PI_UB_ROOT_INSTANCE_ID: "root00",
					XDG_CACHE_HOME: WORK,
				},
				`({
					dir: c.getBlenderBridgeDir(),
					root: c.getBlenderBridgeRootDir(),
					instance: c.getBlenderInstanceId(),
				})`),
			{
				dir: join(WORK, "pi-blender", "bridge", "abc123"),
					root: join(WORK, "pi-blender", "bridge"),
					instance: "abc123",
			},
		);
	});

	test("a pinned bridge dir is honoured exactly and claims no root", () => {
		assert.deepEqual(
			configIn(
				{
					PI_BLENDER_BRIDGE_DIR: join(WORK, "pinned"),
					PI_BLENDER_INSTANCE_ID: "abc123",
					PI_UB_ROOT_INSTANCE_ID: "root00",
				},
				`({ dir: c.getBlenderBridgeDir(), ownership: c.describeBlenderInstanceOwnership() })`,
			),
			{
				dir: join(WORK, "pinned"),
				// Under a pin there is one dir by the user's own choice, so root
				// and subagent are indistinguishable and the answer must be false.
				ownership: {
					instanceId: "abc123",
					rootInstanceId: "root00",
					isRoot: false,
					bridgeDir: join(WORK, "pinned"),
					bridgeRootDir: join(WORK, "pinned"),
					pinned: true,
				},
			},
		);
	});

	test("a traversal-shaped instance id is refused rather than escaping the cache", () => {
		for (const hostile of ["../..", "a/b", "a\\b", ".", "..", "", "   ", "x".repeat(65), "a b"]) {
			const out = configIn(
				{ PI_BLENDER_BRIDGE_DIR: "", PI_BLENDER_INSTANCE_ID: hostile, XDG_CACHE_HOME: WORK },
				`({ dir: c.getBlenderBridgeDir(), instance: c.getBlenderInstanceId() })`,
			);
			// A refused id is never used as a path segment. The process mints its
			// own instead, which lands it in a fresh subdir under the same root:
			// the same cache, never a path outside it.
			assert.match(out.instance, /^[A-Za-z0-9]{12}$/, `for ${JSON.stringify(hostile)}: ${out.instance}`);
			assert.equal(out.dir, join(WORK, "pi-blender", "bridge", out.instance), `for ${JSON.stringify(hostile)}`);
		}
	});

	test("an inherited instance id is republished, and the root id is the first loader's", () => {
		assert.deepEqual(
			configIn(
				{
					PI_BLENDER_BRIDGE_DIR: "",
					PI_BLENDER_INSTANCE_ID: "inherited1",
					PI_UB_ROOT_INSTANCE_ID: "the-root0",
					XDG_CACHE_HOME: WORK,
				},
				`({
					instance: c.getBlenderInstanceId(),
					republished: process.env.PI_BLENDER_INSTANCE_ID,
					root: c.getRootBlenderInstanceId(),
					rootRepublished: process.env.PI_UB_ROOT_INSTANCE_ID,
					isRoot: c.isRootBlenderInstance(),
				})`,
			),
			{
				instance: "inherited1",
				republished: "inherited1",
				root: "the-root0",
				rootRepublished: "the-root0",
				// A child that inherited the root's id is not itself the root.
				isRoot: false,
			},
		);
	});

	test("a process that mints its own id is the root, by construction", () => {
		const out = configIn(
			{ PI_BLENDER_BRIDGE_DIR: "", PI_BLENDER_INSTANCE_ID: "", PI_UB_ROOT_INSTANCE_ID: "", XDG_CACHE_HOME: WORK },
			`({
				instance: c.getBlenderInstanceId(),
				root: c.getRootBlenderInstanceId(),
				isRoot: c.isRootBlenderInstance(),
			})`,
		);
		// Dashes stripped, same as pi-blender, so the id reads cleanly in a path
		// and the two extensions agree on the shape.
		assert.match(out.instance, /^[A-Za-z0-9]{12}$/, `minted id is not path-safe: ${out.instance}`);
		assert.equal(out.root, out.instance);
		assert.equal(out.isRoot, true);
	});

	test("the Unity bridge dir and staging dir are independent, and staging is created", () => {
		assert.deepEqual(
			configIn(
				{
					XDG_CACHE_HOME: WORK,
					PI_UNITY_BRIDGE_DIR: "",
					PI_UNITY_BLENDER_STAGING_DIR: join(WORK, "staging-probe"),
				},
				`({ unity: c.getUnityBridgeDir(), staging: c.getStagingDir() })`,
			),
			{
				unity: join(WORK, "pi-unity-vrchat", "bridge"),
				// The Blender flatpak sandbox cannot read the host's /tmp, which is
				// why staging is cache-only -- so the default has to be the cache.
				staging: join(WORK, "staging-probe"),
			},
		);
		assert.ok(existsSync(join(WORK, "staging-probe")), "getStagingDir promises the dir exists");
	});

	test("a bogus heartbeat staleness falls back to 10s", () => {
		for (const [raw, expected] of [
			["", 10_000],
			["not a number", 10_000],
			["0", 10_000],
			["-5", 10_000],
			["2500", 2500],
		]) {
			assert.equal(
				configIn({ PI_UNITY_BLENDER_HEARTBEAT_STALE_MS: raw }, "c.getStaleHeartbeatMs()"),
				expected,
				`for ${JSON.stringify(raw)}`,
			);
		}
		// Unset is the common case, and an empty string is not the same thing:
		// a bare export gives you an empty string, not an absent variable.
		assert.equal(
			configIn({ PI_UNITY_BLENDER_HEARTBEAT_STALE_MS: undefined }, "c.getStaleHeartbeatMs()"),
			10_000,
		);
	});
});

describe("staging pruning", () => {
	// Finding D: createStagingDir made an mkdtemp dir, appended to .transfers.log
	// and returned. Nothing anywhere removed those directories, and nothing read
	// the log, so every transfer left its FBX (plus a textures/ dir on the
	// Blender -> Unity leg) in the cache forever.
	//
	// These run in-process against a real temp staging root rather than through
	// a child process, because pruneStagingDirs is a pure filesystem operation
	// with no module-load-time environment to clear -- unlike config.ts, whose
	// instance ids are published into process.env at import time.

	/** Backdate a path's mtime, which is the only age signal pruneStagingDirs reads. */
	function age(path, ms) {
		const when = new Date(Date.now() - ms);
		utimesSync(path, when, when);
	}

	test("removes directories older than the stated age, and keeps everything newer", async () => {
		const { pruneStagingDirs, STAGING_MAX_AGE_MS } = await loadTs("binder/bridge.ts");
		const root = mkdtempSync(join(WORK, "prune-"));
		const old = join(root, "old-transfer");
		const fresh = join(root, "fresh-transfer");
		mkdirSync(old);
		mkdirSync(fresh);
		writeFileSync(join(old, "model.fbx"), "stale");
		writeFileSync(join(fresh, "model.fbx"), "in flight");
		age(old, STAGING_MAX_AGE_MS + 60_000);
		age(fresh, 60_000);

		const removed = pruneStagingDirs(root);

		assert.deepEqual(removed, [old], `prune reported ${JSON.stringify(removed)}`);
		assert.ok(!existsSync(old), "the stale staging directory is still there");
		assert.ok(existsSync(fresh), "a directory inside the age window was removed");
		assert.equal(readFileSync(join(fresh, "model.fbx"), "utf8"), "in flight", "the fresh file was disturbed");
	});

	test("a directory exactly at the age boundary is kept", async () => {
		// Strictly-greater-than, so the threshold is inclusive of "not yet old
		// enough". Measured off a clock that has already ticked, so this cannot
		// depend on a millisecond landing on the boundary.
		const { pruneStagingDirs, STAGING_MAX_AGE_MS } = await loadTs("binder/bridge.ts");
		const root = mkdtempSync(join(WORK, "prune-boundary-"));
		const edge = join(root, "edge-transfer");
		mkdirSync(edge);
		age(edge, STAGING_MAX_AGE_MS - 60_000);
		assert.deepEqual(pruneStagingDirs(root), [], "a directory just inside the window was removed");
		assert.ok(existsSync(edge));
	});

	test("the number removed in one call is capped, oldest first", async () => {
		const { pruneStagingDirs, STAGING_MAX_AGE_MS, STAGING_PRUNE_MAX_DIRS } = await loadTs("binder/bridge.ts");
		assert.ok(STAGING_PRUNE_MAX_DIRS > 0, "a cap of zero would never prune anything");
		const root = mkdtempSync(join(WORK, "prune-cap-"));
		const total = STAGING_PRUNE_MAX_DIRS + 5;
		const dirs = [];
		for (let index = 0; index < total; index += 1) {
			const path = join(root, `transfer-${String(index).padStart(3, "0")}`);
			mkdirSync(path);
			// Age them in reverse so directory NAME order is the opposite of age
			// order, which is what proves the sort is by mtime and not by name.
			age(path, STAGING_MAX_AGE_MS + (total - index) * 60_000);
			dirs.push(path);
		}

		const removed = pruneStagingDirs(root);

		assert.equal(removed.length, STAGING_PRUNE_MAX_DIRS, `removed ${removed.length} dirs, cap is ${STAGING_PRUNE_MAX_DIRS}`);
		assert.deepEqual(
			removed,
			dirs.slice(0, STAGING_PRUNE_MAX_DIRS),
			"the cap did not keep the OLDEST directories",
		);
		assert.ok(existsSync(dirs[total - 1]), "the newest stale directory was removed while older ones were kept");
	});

	test("a concurrent transfer's own directory is never a candidate", async () => {
		// The property the cap exists to protect, stated directly: the directory
		// a transfer is creating right now is younger than the age window, so no
		// cap and no ordering can reach it.
		const { pruneStagingDirs, STAGING_MAX_AGE_MS } = await loadTs("binder/bridge.ts");
		const root = mkdtempSync(join(WORK, "prune-concurrent-"));
		for (let index = 0; index < 30; index += 1) {
			const path = join(root, `stale-${index}`);
			mkdirSync(path);
			age(path, STAGING_MAX_AGE_MS + 60_000);
		}
		const concurrent = join(root, "unity-to-blender-live");
		mkdirSync(concurrent);

		pruneStagingDirs(root);

		assert.ok(existsSync(concurrent), "a live transfer's staging directory was pruned");
	});

	test("files and symlinks in the staging root are never removed", async () => {
		// .transfers.log is a FILE in this directory and must survive, so the
		// prune has to be directory-only. The symlink case is why isDirectory()
		// is checked instead of just deleting whatever is old: a symlink to a
		// directory reports isSymbolicLink(), and recursive removal would follow
		// it out of the cache entirely.
		const { pruneStagingDirs, STAGING_MAX_AGE_MS } = await loadTs("binder/bridge.ts");
		const root = mkdtempSync(join(WORK, "prune-files-"));
		const outside = mkdtempSync(join(WORK, "prune-outside-"));
		writeFileSync(join(outside, "keep-me.txt"), "not staging");
		const logPath = join(root, ".transfers.log");
		writeFileSync(logPath, "2026-01-01T00:00:00.000Z /some/old/dir\n");
		const link = join(root, "link-to-elsewhere");
		symlinkSync(outside, link, "dir");
		age(logPath, STAGING_MAX_AGE_MS * 10);
		age(link, STAGING_MAX_AGE_MS * 10);

		const removed = pruneStagingDirs(root);

		assert.deepEqual(removed, [], `prune tried to remove ${JSON.stringify(removed)}`);
		assert.ok(existsSync(logPath), "the transfer log was removed");
		assert.ok(existsSync(join(outside, "keep-me.txt")), "the prune followed a symlink out of the cache");
	});

	test("createStagingDir prunes, and still returns a usable fresh directory", async () => {
		const { createStagingDir, STAGING_MAX_AGE_MS } = await loadTs("binder/bridge.ts");
		const root = mkdtempSync(join(WORK, "prune-create-"));
		const stale = join(root, "blender-to-unity-stale");
		mkdirSync(stale);
		age(stale, STAGING_MAX_AGE_MS + 60_000);

		const dir = createStagingDir("unity-to-blender", root);

		assert.ok(existsSync(dir), "createStagingDir did not return an existing directory");
		assert.ok(!existsSync(stale), "createStagingDir did not prune the stale directory");
		assert.ok(readFileSync(join(root, ".transfers.log"), "utf8").includes(dir), "the transfer was not logged");
	});

	test("a staging root that cannot be read prunes nothing and does not throw", async () => {
		// Housekeeping must never be the reason a transfer cannot start.
		const { pruneStagingDirs } = await loadTs("binder/bridge.ts");
		assert.deepEqual(pruneStagingDirs(join(WORK, "does-not-exist-at-all")), []);
	});
});
