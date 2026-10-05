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
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";

import { loadTs } from "./paths.mjs";

const PLACEHOLDER = "__PI_BINDER_CONFIG__";
const SCRIPT_DIR = join(import.meta.dirname, "..", "binder", "scripts");

/**
 * The interpreter used for the syntax checks, resolved through PATH rather than
 * hardcoded. These checks do not run Blender -- they only compile a rendered
 * file -- so they are NOT behind NEEDS_BLENDER, and must therefore work on a
 * machine with no Blender at all. That also means a runner without python3
 * needs a named reason, not an ENOENT inside an assert.
 */
const pythonFound = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
const PYTHON = pythonFound.status === 0 ? "python3" : "";
/** These checks need python3 but NOT Blender. */
const NEEDS_PYTHON = { skip: PYTHON === "" ? "python3 not found on PATH; cannot check rendered scripts" : false };

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
 * Every script in binder/scripts, GLOBBED -- so a NEW script cannot be added
 * without a test.
 *
 * The list was hardcoded, which is precisely the failure its own comment warns
 * about: the list of scripts that mattered lived somewhere else, so adding a
 * fourth .py changed nothing here and the new script shipped untested. That is
 * how export_fbx.py's rig bug stayed invisible.
 *
 * Globbed at module scope rather than inside the test so the "covered" set is
 * read once from disk, and asserted EQUAL in both directions below: an extra
 * file must fail, and so must a name listed here that is gone.
 */
const SCRIPTS = readdirSync(SCRIPT_DIR)
	.filter((name) => name.endsWith(".py"))
	.map((name) => name.replace(/\.py$/, ""))
	.sort();

// Detection runs HERE, at module scope, and not in a `before` hook -- see the
// comment on BLENDER for why that is the whole fix.
const { detectBlender } = await loadTs("binder/editors.ts");
const { renderBinderScript } = await loadTs("binder/script-template.ts");
const detected = await detectBlender();

/**
 * The Blender these tests run in, or the reason there is none.
 *
 * THREE separate bugs lived in "skip this file when there is no Blender", and
 * each one only shows on a machine WITHOUT Blender -- which is exactly the
 * runner, and exactly why this went unnoticed until CI:
 *
 * 1. `detected.searched` does not exist. EditorDetection is
 *    {found, how, detail}, so `detected.searched.join(", ")` raised
 *    `Cannot read properties of undefined (reading 'join')` INSIDE the hook,
 *    where node:test reports it as the file's own failure and cancels every
 *    test in it. The skip was never reached.
 *
 * 2. A `skip()` called inside `before` does not reach tests nested in
 *    `describe`. The hook is the FILE's; a test inside describe("import_obj")
 *    is the SUITE's. node:test let them start and then cancelled each with
 *    `test did not finish before its parent and was cancelled` -- 17 failures
 *    that all read like broken tests and were one missing binary.
 *
 * 3. So the skip moved to each test's own `skip` option -- and a function there
 *    is evaluated when the test is REGISTERED, which is before any hook has run
 *    and before any module-level state is set. Measured on node 22.23, every
 *    return value skips, truthy or not:
 *      skip: () => true / false / null / undefined / 0 / "" / "x"  -> skipped
 *    A function is for computing the reason, not for deciding whether to skip.
 *
 * So detection happens at module scope, before a single test is declared, and
 * the boolean is baked into the option object. Nothing here needs `skip()`'s
 * ability to abort a running file, because by the time any test could start the
 * answer is already known.
 */
const ROUTES = ["$BLENDER_PATH", "/Applications/Blender.app", "flatpak org.blender.Blender", "blender on PATH"];
/** Prefixed to the detected command so a mis-skip names itself in the log. */
const NEEDS_BLENDER = { skip: detected.found ? false : `no Blender found; checked ${ROUTES.join(", ")}` };

before(() => {
	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	if (detected.found) {
		// detectBlender reports an APP ID for flatpak and a command otherwise, so
		// the id has to become a `flatpak run` before it can be exec'd. Deciding
		// that here rather than in editors.ts is the point: the binder never
		// launches Blender itself (it talks to the live session's bridge), so a
		// runnable command is a thing only this suite needs.
		blenderCommand = detected.how === "flatpak" ? ["flatpak", "run", detected.detail] : [detected.detail.split(/\s+/)[0]];
		process.stderr.write(`binder-scripts: using Blender via ${detected.how} (${detected.detail})\n`);
	} else {
		// stderr, not stdout: the reporter counts stdout, and a reason for
		// skipping belongs beside the SKIP markers either way.
		process.stderr.write(`binder-scripts: skipping -- ${NEEDS_BLENDER.skip}\n`);
	}
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

/**
 * Render a binder script through the REAL renderer.
 *
 * This used to re-implement the substitution itself -- read the template,
 * assert the placeholder is there, JSON.stringify the config, replace, write.
 * A copy of the renderer inside the file that tests the renderer means the two
 * can drift, and the drift is invisible: the tests would keep passing against
 * the copy while binder/script-template.ts did something else. So it calls the
 * real function, and the only thing this helper still owns is the temp path.
 */
function render(name, config) {
	return renderBinderScript(name, config, join(work, `${name}-${Math.random().toString(36).slice(2)}.py`));
}

/**
 * A config hostile in every way the baked-in-literal contract has to survive.
 *
 * Every one of these is a name or path that can occur in a real project: a
 * Unity GameObject may be called anything a user typed, and a staged path is
 * built from the model's own name. The list covers the four things that break
 * a naive interpolation -- double quotes, newlines, backslashes, and the
 * dollar-brace shape that a template language would expand -- plus Python's own
 * triple-quote and raw-string delimiters, since the literal is wrapped in r\"\"\".
 */
const HOSTILE_CONFIG = {
	outPath: '/tmp/qu"o\\te\nnew.py',
	mtlPath: null,
	objectNames: [
		'He said "hello"',
		"line1\nline2",
		"back\\slash",
		"${injected}",
		"\'\'\' + os.system(\"touch \" + PWNED_MARKER + \"\") + \'\'\'",
		'"""',
		"r\"\"",
	],
	collectionName: "Pi_'Quoted'",
	flipUpAxis: true,
};

/** Where the canary value would create a file if it were ever EXECUTED. */
const PWNED_MARKER = join(work, "pwned-canary");

/**
 * Read a rendered script's baked config back out the way the script itself
 * does -- json.loads over the r-string literal -- and print it as JSON.
 *
 * Deliberately duplicates the extraction rather than running the script: the
 * script imports bpy, so it cannot be imported here, and running it with a
 * Blender-specific stub would test the stub. Regex on the exact shape the
 * templates use is enough to prove the literal itself round-trips.
 */
const READ_CONFIG_LITERAL = [
	"import json, re, sys",
	"text = open(sys.argv[1], encoding='utf-8').read()",
	"m = re.search(r'json\\.loads\\(r?\"\"\"(.*?)\"\"\"\\)', text, re.S)",
	"assert m, 'no baked config literal found'",
	"print(json.dumps(json.loads(m.group(1))))",
].join("\n");

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

describe("binder scripts", NEEDS_BLENDER, () => {
	describe("the render step", () => {
		test("every script in binder/scripts is covered by this file", () => {
			// SCRIPTS is globbed from disk, so this asserts the two sets are the
			// same. It also fails if binder/scripts has no .py at all, which a
			// hardcoded list would have reported as a pass.
			assert.ok(SCRIPTS.length > 0, `no .py scripts found in ${SCRIPT_DIR}`);

			// Which of the globbed scripts this file actually renders somewhere.
			// Read from this file's OWN source, so "covered" means a real call,
			// not a name written down here -- which is what made the hardcoded
			// list worthless.
			const rendered = new Set(
				[...readFileSync(import.meta.filename, "utf8").matchAll(/render\(\s*"(\w+)"/g)].map((m) => m[1]),
			);
			// Equal in both directions, so a new script on disk and a script
			// deleted from disk both fail.
			assert.deepEqual(
				SCRIPTS,
				[...rendered].sort(),
				`binder/scripts holds [${SCRIPTS.join(", ")}] but this file renders [${[...rendered].sort().join(", ")}]`,
			);
		});

		test("every rendered script compiles, and its config survives as DATA", NEEDS_PYTHON, () => {
			// The config is baked in as a JSON literal inside an r-string, which is
			// the only reason a user's object name containing a quote or a newline
			// cannot break the script. That claim was previously "checked" by
			// asserting the rendered text contained '"outPath"' -- which is true of
			// the untouched template, so it passed for any config at all and never
			// parsed a line of Python. The comment even named the hostile case as
			// the interesting one, then passed a config with nothing hostile in it.
			//
			// So: render each script with a config hostile in every way JSON can be
			// asked to escape, and COMPILE the result.
			for (const script of SCRIPTS) {
				const destination = renderBinderScript(script, HOSTILE_CONFIG, join(work, `syntax-${script}.py`));
				const text = readFileSync(destination, "utf8");
				assert.ok(!text.includes(PLACEHOLDER), `${script}.py still contains ${PLACEHOLDER} after rendering`);
				assert.ok(text.includes("CONFIG = json.loads"), `${script}.py lost its config load`);

				// py_compile, not an import: importing would execute the module,
				// which needs bpy and only exists inside Blender. Compiling is the
				// syntax check, which is exactly what a broken escape produces.
				const compiled = spawnSync(PYTHON, ["-m", "py_compile", destination], { encoding: "utf8" });
				assert.equal(
					compiled.status,
					0,
					`${script}.py did not compile with a hostile config:\n${compiled.stderr}`,
				);

				// Compiling is not enough. A mis-escaped literal is still valid
				// Python -- it just hands the script a DIFFERENT path than the one
				// passed in, which fails at run time inside Blender with a path
				// error. So read the literal back the way the script does and
				// compare it to what was passed. This is the assertion that would
				// have caught a shell or string-interpolation regression.
				const readBack = spawnSync(
					PYTHON,
					["-c", READ_CONFIG_LITERAL, destination],
					{ encoding: "utf8" },
				);
				assert.equal(
					readBack.status,
					0,
					`could not re-read ${script}.py's baked config the way the script does:\n${readBack.stderr}`,
				);
				assert.deepEqual(
					JSON.parse(readBack.stdout.trim()),
					HOSTILE_CONFIG,
					`${script}.py's baked config did not survive the round trip -- the escaping is wrong`,
				);
			}

			// The canary: if any part of the pipeline built the file by string
			// substitution, this value is Python SOURCE rather than a string, and
			// it runs at import. Compiling alone would not notice, because the
			// substituted source is syntactically fine.
			assert.ok(
				!existsSync(PWNED_MARKER),
				"a config value was executed as Python source: the config is not being interpolated as data",
			);
		});
	});

	describe("import_obj", NEEDS_BLENDER, () => {
		test("names the object after the GameObject, not the file", NEEDS_BLENDER, () => {
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

		test("collects the batch under one collection", NEEDS_BLENDER, () => {
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

		test("a missing file is an error, not a silent empty import", NEEDS_BLENDER, () => {
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

		// ---------------------------------------------------------------------
		// The flip has to be BAKED, not left as a live negative scale.
		//
		// Measured on Blender 5.2, a tetra under the old `scale.y *= -1` ends up
		// with determinant -1 and, on EVERY face, a stored vertex normal that
		// disagrees with the face's own winding by exactly -1.0 dot product.
		// Blender DOES reverse winding under a mirror but does NOT reverse the
		// stored normals, so the object shades inside-out and every count in the
		// summary still looks right. After baking (mesh.transform + flip_normals)
		// the same object is at determinant 1 with every face agreeing at +1.0.
		//
		// So the assertions here are on normals-versus-winding, which is what
		// actually differs between the two implementations, plus the object
		// transform, which must not be left mirroring.
		// ---------------------------------------------------------------------

		/** Asymmetric, so a mirror moves it and a symmetry hides the defect. */
		const OBJ_TETRA =
			"g Tet\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n";

/**
 * Report the named mesh the way the finding is measured, as one JSON line.
 *
 * Deliberately does NOT run CLEAR: this runs in the SAME process as the import
 * it measures, so a cleanup fixture would delete the very object under test
 * (measured -- it produced `KeyError: 'Tet'`).
 */
function measureFlipFixture(name) {
	return fixture(
		`measure-flip-${name}`,
		`import bpy, json as _json
from mathutils import Vector
obj = bpy.data.objects[${JSON.stringify(name)}]
m3 = obj.matrix_world.to_3x3()
co = [m3 @ v.co for v in obj.data.vertices]
centre = sum(co, Vector()) / len(co)
agree, outward = [], []
for poly in obj.data.polygons:
    stored = (m3 @ poly.normal).normalized()
    vs = [co[i] for i in poly.vertices]
    winding = (vs[1] - vs[0]).cross(vs[2] - vs[0]).normalized()
    face_centre = sum(vs, Vector()) / len(vs)
    agree.append(round(sum(a * b for a, b in zip(stored, winding)), 3))
    outward.append(round(sum(a * b for a, b in zip(stored, (face_centre - centre).normalized())), 3))
print("FLIP=" + _json.dumps({"name": obj.name, "scale": list(obj.scale), "determinant": obj.matrix_world.determinant(), "agree": agree, "outward": outward}))
`,
	);
}

/** The FLIP= line, or a failure naming what was printed instead. */
function readFlip(stdout) {
	const line = stdout.split("\n").find((l) => l.startsWith("FLIP="));
	assert.ok(line, `no FLIP line:\n${stdout.slice(-2000)}`);
	return JSON.parse(line.slice("FLIP=".length));
}

/**
 * Assert the mesh carries no mirroring transform and is shaded OUTSIDE.
 *
 * Two independent metrics, because they catch different broken implementations
 * and a test with only one of them passes the other's bug. Measured on Blender
 * 5.2 with the tetra below:
 *
 *   implementation                     scale      det  agree  outward
 *   scale.y *= -1 (the old code)        [1,-1,1]   -1   -1.0    +0.9
 *   transform() only, no flip_normals   [1,1,1]    +1   +1.0    -0.9
 *   transform() + flip_normals          [1,1,1]    +1   +1.0    +0.9
 *
 * `agree` (stored normal vs the face's own winding) is -1 under the old code,
 * because Blender reverses winding under a mirror but not the stored normals.
 * `outward` (stored normal vs the direction away from the mesh centroid) is -1
 * under a half-fix that mirrors positions without flipping normals, which
 * `agree` cannot see -- mirroring positions alone leaves the two in agreement
 * with each other, pointing the wrong way.
 *
 * So a correct mesh needs det 1, no negative scale, agree all +1 AND outward
 * all +1, and any single one of those four would have passed a weaker test.
 */
function assertCorrectlyShaded(measured, because) {
	assert.deepEqual(measured.scale, [1, 1, 1], `${because}: the mirror was left as a live object scale`);
	assert.equal(measured.determinant, 1, `${because}: the object matrix still mirrors, so normals cannot be trusted`);
	assert.ok(measured.agree.length > 0, `${because}: no faces were measured`);
	for (const [index, dot] of measured.agree.entries()) {
		// -1 is the exact signature of an un-flipped stored normal under a
		// mirror: the winding was reversed, the normal was not.
		assert.equal(
			dot,
			1,
			`${because}: face ${index}'s stored normal disagrees with its winding (dot ${dot}) -- inside-out shading`,
		);
	}
	for (const [index, dot] of measured.outward.entries()) {
		assert.ok(
			dot > 0,
			`${because}: face ${index}'s stored normal points INTO the mesh (dot ${dot}) -- the geometry is inside-out`,
		);
	}
}

/** Render an OBJ import of the tetra with the given flipUpAxis. */
		function renderTetra(flipUpAxis) {
			const objPath = join(work, "tetra.obj");
			writeFileSync(objPath, OBJ_TETRA);
			return render("import_obj", {
				objPath,
				mtlPath: null,
				objectNames: ["Tet"],
				collectionName: "Pi_Flip",
				flipUpAxis,
			});
		}

		test("flipUpAxis bakes the mirror into the mesh, normals and winding together", NEEDS_BLENDER, () => {
			const { stdout, stderr } = runInBlender([renderTetra(true), measureFlipFixture("Tet")]);
			assert.ok(stdout.includes("FLIP="), `the measurement fixture did not run:\n${stderr.slice(-2000)}`);
			assertCorrectlyShaded(readFlip(stdout), "after an OBJ import with flipUpAxis");
		});

		test("flipUpAxis: false leaves the geometry as authored", NEEDS_BLENDER, () => {
			// The control for the test above. If this also came out at -1, the
			// measurement would be measuring something other than the flip.
			const { stdout, stderr } = runInBlender([renderTetra(false), measureFlipFixture("Tet")]);
			assert.ok(stdout.includes("FLIP="), `the measurement fixture did not run:\n${stderr.slice(-2000)}`);
			assertCorrectlyShaded(readFlip(stdout), "after an OBJ import without a flip");
		});

		test("the flip is reported as flippedRoots, and only when it happened", NEEDS_BLENDER, () => {
			const on = summary(runInBlender(renderTetra(true)).stdout);
			assert.deepEqual(on.flippedRoots, ["Tet"], "the flipped mesh was not reported");

			const off = summary(runInBlender(renderTetra(false)).stdout);
			assert.deepEqual(off.flippedRoots, [], "flipUpAxis: false still reported a flip");
		});

		test("a round trip through FBX restores the handedness exactly once", NEEDS_BLENDER, () => {
			// The claim in SKILL.md and in the transfer's own note: send it back
			// and the handedness comes back once, not doubled. Unity -> Blender
			// (OBJ, flipped) -> Unity (FBX, unflipped) is exactly that path, and
			// a doubled or uncancelled flip arrives as a negative determinant or
			// as faces whose normals disagree with their winding.
			//
			// The reimported object lands as "Tet.001" because the OBJ import
			// already owns the name, so the measurement names it explicitly
			// rather than reaching for "Tet" and measuring the pre-export mesh.
			const { stdout, stderr } = runInBlender([
				renderTetra(true),
				render("export_fbx", { outPath: join(work, "roundtrip.fbx"), textureDir: null, objectNames: ["Tet"] }),
				render("import_fbx", {
					fbxPaths: [join(work, "roundtrip.fbx")],
					collectionName: "Pi_Flip",
					flipUpAxis: false,
				}),
				measureFlipFixture("Tet.001"),
			]);
			assert.ok(stdout.includes("FLIP="), `the measurement fixture did not run:\n${stderr.slice(-2000)}`);
			assertCorrectlyShaded(readFlip(stdout), "after the FBX round trip");
		});
	});

	describe("export_fbx", NEEDS_BLENDER, () => {
		test("a rig crosses with its bones", NEEDS_BLENDER, () => {
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

		test("a curve crosses as geometry and the user's scene keeps its curve", NEEDS_BLENDER, () => {
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

		test("the user's scene is left as it was found", NEEDS_BLENDER, () => {
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

		test("a named object that does not exist is an error naming what is available", NEEDS_BLENDER, () => {
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

	describe("import_fbx", NEEDS_BLENDER, () => {
		test("a rig crosses with its bones and is reported as one", NEEDS_BLENDER, () => {
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

		test("an fbx with no bones reports an empty armature list rather than failing", NEEDS_BLENDER, () => {
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

		test("an fbx path that does not exist is an error naming the path", NEEDS_BLENDER, () => {
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
