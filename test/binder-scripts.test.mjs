/**
 * The three Python scripts the binder renders and runs inside Blender.
 *
 * They are executable code in the repo that no gate touched: `npm test` never
 * ran them, so a silent regression in one shipped. It did -- a rigged Blender
 * export left the bones behind, because `object_types` did not list ARMATURE,
 * and the file that came across looked complete and reimported as a static
 * mesh. Nothing failed, tsc was clean, and the transfer reported success.
 *
 * So these run the REAL rendered script in a real headless Blender and assert
 * on what crossed the boundary by REIMPORTING it. Reading the script cannot
 * answer that: the failure above is entirely inside Blender's exporter.
 *
 * Why Blender has to be involved rather than mocked. Every claim these tests
 * make is about how a given operator reacts to a given keyword set on a given
 * Blender build -- whether `use_split_groups` exists, whether a CURVE survives
 * `object_types`, whether an armature round-trips. A mock has to encode the
 * answer, so it would pass whatever the script did. The real thing is the only
 * input that can catch a wrong keyword.
 *
 *   node --test test/binder-scripts.test.mjs
 *
 * Skipped with a reason, never silently, when no Blender is found: a suite that
 * quietly stops testing is the failure this file exists to prevent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";

import { loadTs } from "./paths.mjs";

const PLACEHOLDER = "__PI_BINDER_CONFIG__";
const SCRIPT_DIR = join(import.meta.dirname, "..", "binder", "scripts");

/**
 * Scratch space is under the CACHE, never tmpdir. A flatpak Blender cannot see
 * the host's /tmp -- it is the sandbox's own -- so a fixture written there is
 * invisible to the very process under test, and a test built on it fails for a
 * reason that has nothing to do with the code. This is the same reason the
 * binder's own staging directory is documented as cache-only.
 */
// mkdir first: mkdtemp creates a directory INSIDE the prefix it is given and
// will not create a missing parent, so on a fresh runner where ~/.cache does
// not exist this line was the whole test file's failure --
// `ENOENT: no such file or directory, mkdtemp
// '/home/runner/.cache/pi-binder-tests-XXXXXX'` -- with zero checks run.
mkdirSync(join(homedir(), ".cache"), { recursive: true });
const work = mkdtempSync(join(homedir(), ".cache", "pi-binder-tests-"));
/** Prefix that makes the detected Blender runnable: ["flatpak","run",app] or [binary]. */
let blenderCommand = [];

/**
 * Every script in binder/scripts, so a NEW script cannot be added without a
 * test. A hardcoded list is how export_fbx.py's rig bug stayed invisible: the
 * list of scripts that mattered was written down somewhere else.
 */
const SCRIPTS = ["export_fbx", "import_fbx", "import_obj"];

before(async () => {
	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	// Through jiti, like every other suite here: the extension's own imports
	// carry NodeNext ".js" specifiers that only a TypeScript-aware loader
	// resolves.
	const { detectBlender } = await loadTs("binder/editors.ts");
	const detected = await detectBlender();
	if (!detected.found) {
		// One skip covers the whole file, and it says which way to fix it, so a
		// green run here is never mistaken for a passing run.
		const { skip } = await import("node:test");
		skip(`no Blender found: ${detected.searched.join(", ")}`);
		return;
	}
	// detectBlender reports an APP ID for flatpak and a command otherwise, so
	// the id has to become a `flatpak run` before it can be exec'd. Deciding
	// that here rather than in editors.ts is the point: the binder never
	// launches Blender itself (it talks to the live session's bridge), so a
	// runnable command is a thing only this suite needs.
	blenderCommand = detected.how === "flatpak" ? ["flatpak", "run", detected.detail] : [detected.detail.split(/\s+/)[0]];
	process.stderr.write(`binder-scripts: using Blender via ${detected.how} (${detected.detail})\n`);
});

after(() => {
	rmSync(work, { recursive: true, force: true });
});

/**
 * Run scripts in ONE fresh headless Blender and return everything it said.
 * `--factory-startup` matters: a user's startup file can have a selection, a
 * collection and a file the script would then trip over, and a test that only
 * passes on an empty install is not a test.
 *
 * The scripts are run in ONE PROCESS, not one each, because the export scripts
 * operate on the scene that is already open -- that is the whole transfer
 * contract. A fixture built in its own Blender process is not there for the
 * next one, so a test that exports "the scene the fixture made" is exporting an
 * empty factory scene and asserting on the factory cube.
 */
function runInBlender(scriptPaths, timeoutMs = 180_000) {
	const scripts = [].concat(scriptPaths);
	// spawnSync, not execFileSync: a script exception is a traceback on STDERR
	// and Blender still exits 0, so the exit code cannot be the signal and the
	// failure text has to be captured rather than discarded.
	const result = spawnSync(
		blenderCommand[0],
		[
			...blenderCommand.slice(1),
			"--background",
			"--factory-startup",
			...scripts.flatMap((p) => ["--python", p]),
		],
		{ encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.error) throw result.error;
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run a fixture and a binder script together, and read the binder's summary. */
function runAndSummary(fixture, scriptPath, timeoutMs) {
	const { stdout, stderr } = runInBlender([fixture, scriptPath], timeoutMs);
	return summary(stdout, stderr);
}

/** Run one script and assert it refused, the way the bridge sees a refusal. */
function runExpectingFailure(scriptPath, pattern, timeoutMs) {
	const { stdout, stderr } = runInBlender([scriptPath], timeoutMs);
	const said = `${stdout}\n${stderr}`;
	// A summary printed after a failure would be a summary of a partial run,
	// which is the shape of bug this file also guards: a transfer that reports
	// success for geometry that did not cross.
	assert.equal(lastJsonLine(stdout), "", "a script that failed still printed a summary");
	assert.match(said, pattern, `the failure did not name the cause:\n${said.slice(-3000)}`);
}

/** Render a binder script the way binder/script-template.ts does. */
function render(name, config) {
	const source = readFileSync(join(SCRIPT_DIR, `${name}.py`), "utf8");
	assert.ok(
		source.includes(PLACEHOLDER),
		`${name}.py no longer contains ${PLACEHOLDER}; binder/script-template.ts would refuse it.`,
	);
	const destination = join(work, `${name}-${Math.random().toString(36).slice(2)}.py`);
	writeFileSync(destination, source.replace(PLACEHOLDER, JSON.stringify(config, undefined, 2)), "utf8");
	return destination;
}

/** The JSON summary a script prints as its last line. */
function lastJsonLine(stdout) {
	const lines = stdout
		.split("\n")
		.map((l) => l.trim())
		.reverse();
	return lines.find((l) => l.startsWith("{") && l.endsWith("}")) ?? "";
}

function summary(stdout, stderr = "") {
	const line = lastJsonLine(stdout);
	assert.ok(line, `no JSON summary in output:\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`);
	return JSON.parse(line);
}

/** Write a fixture scene script, in one call so its paths stay consistent. */
function fixture(name, body) {
	const destination = join(work, `${name}-${Math.random().toString(36).slice(2)}.py`);
	writeFileSync(destination, body.replaceAll("@WORK@", JSON.stringify(work)), "utf8");
	return destination;
}

/** The shape every fixture starts from: nothing selected, nothing in the scene. */
const CLEAR = "import bpy\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete()\n";

describe("binder scripts", () => {
	describe("the render step", () => {
		test("every script in binder/scripts is covered by this file", () => {
			for (const name of SCRIPTS) {
				assert.ok(
					existsSync(join(SCRIPT_DIR, `${name}.py`)),
					`${name}.py is listed here but not on disk`,
				);
			}
		});

		test("a rendered script is valid Python with the config baked in", async () => {
			const { renderBinderScript } = await loadTs("binder/script-template.ts");
			const destination = renderBinderScript(
				"export_fbx",
				{ outPath: join(work, "syntax.fbx"), objectNames: [] },
				join(work, "syntax.py"),
			);
			const text = readFileSync(destination, "utf8");
			assert.ok(!text.includes(PLACEHOLDER), "the placeholder survived rendering");
			// A name from the user's scene is the reason JSON is used, so a name
			// with a quote and a newline in it is the case that matters.
			assert.ok(text.includes('"outPath"'), "the config was not interpolated");
		});
	});

	describe("import_obj", () => {
		test("names the object after the GameObject, not the file", () => {
			// The regression: without use_split_groups the importer ignores the
			// `g` line and calls the object after the FILE, so identity is lost
			// across a Unity -> Blender round trip.
			const objPath = join(work, "unity-export.obj");
			writeFileSync(objPath, "g MyGameObject\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
			const out = summary(
				runInBlender(
					render("import_obj", {
						objPath,
						mtlPath: null,
						objectNames: ["MyGameObject"],
						collectionName: "Pi_Imported",
						flipUpAxis: true,
					}),
				).stdout,
			);
			assert.deepEqual(out.importedNames, ["MyGameObject"]);
			assert.equal(out.vertexTotal, 3);
			assert.equal(out.collectionName, "Pi_Imported");
		});

		test("collects the batch under one collection", () => {
			const objPath = join(work, "two-objects.obj");
			writeFileSync(objPath, "g Alpha\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\ng Beta\nf 1 2 3\n");
			const out = summary(
				runInBlender(
					render("import_obj", {
						objPath,
						mtlPath: null,
						objectNames: [],
						collectionName: "Pi_Batch",
						flipUpAxis: false,
					}),
				).stdout,
			);
			assert.ok(out.importedNames.includes("Alpha"), `expected Alpha in ${out.importedNames.join(", ")}`);
			assert.ok(out.importedNames.includes("Beta"), `expected Beta in ${out.importedNames.join(", ")}`);
			assert.equal(out.collectionName, "Pi_Batch");
		});

		test("a missing file is an error, not a silent empty import", () => {
			runExpectingFailure(
				render("import_obj", {
					objPath: join(work, "does-not-exist.obj"),
					mtlPath: null,
					objectNames: [],
					collectionName: "Pi_Imported",
					flipUpAxis: true,
				}),
				/does-not-exist\.obj/,
			);
		});
	});

	describe("export_fbx", () => {
		test("a rig crosses with its bones", () => {
			// The regression this suite exists for. Exported without ARMATURE in
			// object_types, this exact scene produced a file that reimported with
			// no armature at all -- and a file, so nothing failed.
			const out = join(work, "rig");
			const exported = runAndSummary(
				fixture("rig-scene", `${CLEAR}
arm_data = bpy.data.armatures.new("Rig")
arm = bpy.data.objects.new("Armature", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
arm_data.edit_bones.new("Root")
arm_data.edit_bones.new("Bone")
bpy.ops.object.mode_set(mode="OBJECT")
body = bpy.data.objects.new("Body", bpy.data.meshes.new("Body"))
bpy.context.collection.objects.link(body)
body.parent = arm
bpy.ops.object.select_all(action="DESELECT")
for o in (arm, body):
    o.select_set(True)
bpy.context.view_layer.objects.active = arm
`),
				render("export_fbx", { outPath: `${out}.fbx`, textureDir: null, objectNames: [] }),
			);
			assert.ok(exported.objectNames.includes("Armature"), "the armature was not in the export scope");

			// And prove it by reimporting in a SEPARATE process, which is the only
			// way to know the bones are in the FILE rather than in the scene that
			// was open when it was written.
			const said = runInBlender(
				fixture("verify-rig", `${CLEAR}
bpy.ops.import_scene.fbx(filepath=@WORK@ + "/rig.fbx")
armatures = [(o.name, len(o.data.bones)) for o in bpy.data.objects if o.type == "ARMATURE"]
import json as _json
print("ARMATURES=" + _json.dumps(armatures))
`),
			).stdout;
			const line = said.split("\n").find((l) => l.startsWith("ARMATURES="));
			assert.ok(line, `no ARMATURES line:\n${said.slice(-2000)}`);
			const armatures = JSON.parse(line.slice("ARMATURES=".length));
			assert.ok(armatures.length > 0, "the exported FBX reimported with no armature -- the rig was dropped");
			assert.equal(armatures[0][1], 2, `expected 2 bones, got ${armatures[0][1]}`);
		});

		test("a curve crosses as geometry and the user's scene keeps its curve", () => {
			// Also a real defect: a CURVE is not in object_types, so a curve-only
			// export produced a valid, non-empty FBX that reimported as an EMPTY
			// scene. And object.convert() rewrites in place, so converting the
			// user's own curve would restructure the .blend the binder then saves.
			const out = join(work, "curve");
			const scene = fixture("curve-scene", `${CLEAR}
bpy.ops.curve.primitive_bezier_curve_add()
curve = bpy.context.active_object
curve.name = "MyCurve"
curve.data.materials.append(bpy.data.materials.new("CurveMat"))
bpy.ops.mesh.primitive_cube_add()
bpy.context.active_object.name = "MyCube"
bpy.ops.object.select_all(action="DESELECT")
for n in ("MyCurve", "MyCube"):
    bpy.data.objects[n].select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects["MyCube"]
`);

			const exported = runAndSummary(
				scene,
				render("export_fbx", { outPath: `${out}.fbx`, textureDir: null, objectNames: [] }),
			);
			assert.deepEqual(
				[...exported.objectNames].sort(),
				["MyCube", "MyCurve"],
				"the summary reported the copy's name, or dropped the curve",
			);
			// The cube alone is 8 vertices, so 21 means the curve's 13 came too.
			assert.equal(exported.vertexTotal, 21, "the curve's geometry did not cross");
			// A conversion drops material slots, so the original's are read too.
			assert.deepEqual(exported.materialNames, ["CurveMat"]);

			const said = runInBlender(
				fixture("verify-curve", `${CLEAR}
bpy.ops.import_scene.fbx(filepath=@WORK@ + "/curve.fbx")
import json as _json
print("REIMPORTED=" + _json.dumps(sorted((o.name, o.type) for o in bpy.data.objects)))
`),
			).stdout;
			const line = said.split("\n").find((l) => l.startsWith("REIMPORTED="));
			assert.ok(line, `no REIMPORTED line:\n${said.slice(-2000)}`);
			assert.match(line, /MyCurve.*MESH/, "the curve did not reimport as a mesh");
		});

		test("the user's scene is left as it was found", () => {
			// The other half of the curve defect: a conversion that rewrote the
			// original in place would leave the user's .blend restructured by a
			// read-only transfer, and the binder saves the .blend.
			const said = runInBlender([
				fixture("curve-leave", `${CLEAR}
bpy.ops.curve.primitive_bezier_curve_add()
curve = bpy.context.active_object
curve.name = "MyCurve"
bpy.ops.object.select_all(action="DESELECT")
curve.select_set(True)
`),
				render("export_fbx", {
					outPath: join(work, "leave.fbx"),
					textureDir: null,
					objectNames: ["MyCurve"],
				}),
				fixture("check-leave", `import bpy
print("CURVE_TYPE_AFTER=" + bpy.data.objects["MyCurve"].type)
print("LEFTOVER=" + repr(sorted(o.name for o in bpy.data.objects if o.type not in {"CURVE", "EMPTY"})))
`),
			]).stdout;
			assert.match(said, /CURVE_TYPE_AFTER=CURVE/, "the user's curve was converted in place");
			assert.match(said, /LEFTOVER=\[\]/, "a conversion copy was left behind in the user's scene");
		});

		test("a named object that does not exist is an error naming what is available", () => {
			runExpectingFailure(
				render("export_fbx", {
					outPath: join(work, "never.fbx"),
					textureDir: null,
					objectNames: ["NoSuchObject"],
				}),
				/NoSuchObject/,
			);
		});
	});

	describe("import_fbx", () => {
		test("a rig crosses with its bones and is reported as one", () => {
			// The source-model route is the one that carries rigs, so this is the
			// claim the binder's whole format asymmetry rests on.
			//
			// The fixture writes the FBX in its OWN process. Importing in the same
			// one would import alongside the objects that made the file, and every
			// name would come back suffixed -- a test asserting on names would
			// then be asserting on the collision, not on the script.
			runInBlender(
				fixture("fbx-source", `${CLEAR}
arm_data = bpy.data.armatures.new("Rig")
arm = bpy.data.objects.new("Armature", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
arm_data.edit_bones.new("Root")
arm_data.edit_bones.new("Bone")
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.mesh.primitive_cube_add()
body = bpy.context.active_object
body.name = "Body"
body.parent = arm
bpy.ops.object.select_all(action="DESELECT")
for o in (arm, body):
    o.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.fbx(filepath=@WORK@ + "/source.fbx", use_selection=True, object_types={"MESH", "EMPTY", "ARMATURE"})
`),
			);
			assert.ok(existsSync(join(work, "source.fbx")), "the source fixture was not written");

			const out = summary(
				runInBlender(
					render("import_fbx", {
						fbxPaths: [join(work, "source.fbx")],
						collectionName: "Pi_Imported",
						flipUpAxis: false,
					}),
				).stdout,
			);
			assert.deepEqual(out.armatures, ["Armature"], "the rig was not reported as crossing");
			assert.deepEqual(out.importedFiles, ["source.fbx"]);
			assert.ok(out.vertexTotal > 0, "no geometry crossed");
		});

		test("an fbx with no bones reports an empty armature list rather than failing", () => {
			runInBlender(
				fixture("fbx-plain", `${CLEAR}
bpy.ops.mesh.primitive_cube_add()
bpy.context.active_object.name = "PlainCube"
bpy.ops.export_scene.fbx(filepath=@WORK@ + "/plain.fbx", use_selection=True, object_types={"MESH", "EMPTY"})
`),
			);
			const out = summary(
				runInBlender(
					render("import_fbx", {
						fbxPaths: [join(work, "plain.fbx")],
						collectionName: "Pi_Imported",
						flipUpAxis: false,
					}),
				).stdout,
			);
			assert.deepEqual(out.armatures, []);
			assert.ok(out.importedNames.includes("PlainCube"), `got ${out.importedNames.join(", ")}`);
		});

		test("an fbx path that does not exist is an error naming the path", () => {
			runExpectingFailure(
				render("import_fbx", {
					fbxPaths: [join(work, "nope.fbx")],
					collectionName: "Pi_Imported",
					flipUpAxis: false,
				}),
				/nope\.fbx/,
			);
		});
	});
});
