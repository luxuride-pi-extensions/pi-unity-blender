/**
 * Regression tests for the binder's stdout summary parsers.
 *
 * These exist because a field was silently dropped in production. The
 * import script printed `importedFiles` and `armatures`; the parser's return
 * literal listed only four other keys; the caller read the missing two with
 * `?? []`. A Unity->Blender transfer of a rigged FBX therefore reported
 * "no rig came across" for a file that carried three armatures with 186/68/109
 * bones. Nothing failed -- tsc was clean, the transfer returned ok, and the
 * result merely looked sparse.
 *
 * The class of bug is a field being present in the interface, read by the
 * consumer, printed by the script, and dropped in the one place that
 * assembles the object. A count cannot catch that, so these assert on the
 * exact key set.
 */

import { loadTs } from "./paths.mjs";

const { parseImportSummary, parseExportSummary } = await loadTs("binder/transfer.ts");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(detail ? `${name} -- ${detail}` : name);
}

function eq(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	check(name, a === e, `expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// A CAPTURED stdout, next to the reconstructed one below.
//
// The reconstruction is a round trip of the parser's own contract: it was
// written from what the parser should accept, so it can detect a field being
// DROPPED but not a change in what Blender actually prints. This one is real.
//
// Captured on 2026-10-04 from Blender 5.2.0 LTS (flatpak org.blender.Blender)
// running the REAL binder scripts: a two-group OBJ imported with flipUpAxis
// true, then an FBX of a cube named with a non-ASCII name. Three facts in it
// are not in the reconstruction and would not have been guessed:
//
//   1. Blender JSON-encodes non-ASCII as \uXXXX -- "ICO\u7403.001" for
//      "ICO球.001". A parser doing anything with the NAME rather than passing
//      it through would mis-handle this, and only a captured line shows it.
//   2. Blender's OWN chatter interleaves with the script's output and comes
//      AFTER it: "OBJ import of 'cap.obj' took 0.16 ms" and the banner line
//      print below the last summary. The backwards scan exists for exactly
//      this, and here it is with real text rather than an idealised
//      "Blender chatter" placeholder.
//   3. A dropped-keyword NOTE from the importer ("does not support
//      ['add_leaf_bones']") lands on stdout between two summaries, so a
//      transfer with both routes really does print a non-JSON line after a
//      valid one.
//
// Note what this still cannot detect: the scripts' OUTPUT format is defined by
// the scripts, and only Blender's surrounding output is captured here. A change
// to what import_fbx.py prints is still invisible to both fixtures -- what they
// catch is a change to the PARSER's idea of that shape. Keeping both is the
// point: the reconstruction pins the contract, the capture pins the
// environment.
// ---------------------------------------------------------------------------
const CAPTURED_OUTPUT = [
	"FBX export starting... '/home/runner/.cache/pi-binder-tests-x1/cap.fbx'",
	"export finished in 0.0018 sec.",
	'{"importedNames": ["Armature"], "materialNames": [], "collectionName": "Pi_Imported", "vertexTotal": 3, "flippedRoots": ["Armature"]}',
	"NOTE: this Blender's FBX importer does not support ['add_leaf_bones']; skipped",
	"FBX version: 7400",
	'{"importedNames": ["ICO\u7403.001"], "materialNames": [], "collectionName": "Pi_Imported", "vertexTotal": 8, "importedFiles": ["cap.fbx"], "armatures": [], "flippedRoots": []}',
	"Blender 5.2.0 LTS (hash fbe6228777e7 built 2026-07-14 01:32:04)",
	"OBJ import of 'cap.obj' took 0.16 ms",
	"Blender quit",
	"",
].join("\n");

const capturedLast = parseImportSummary(CAPTURED_OUTPUT);
check("a captured stdout parses", capturedLast !== null);
if (capturedLast !== null) {
	// The last summary wins even though Blender printed two lines of banner
	// and chatter after it -- the backwards scan, on real output.
	eq("the captured run's last summary wins", capturedLast.importedFiles, ["cap.fbx"]);
	eq("the captured run's armatures are empty, not missing", capturedLast.armatures, []);
	eq("the captured run's flippedRoots survive", capturedLast.flippedRoots, []);
	// \uXXXX decodes back to the real name, so a caller reading importedNames
	// sees the name Unity used rather than an escape sequence.
	eq("non-ASCII names decode back to the real characters", capturedLast.importedNames, ["ICO球.001"]);
}

// The FIRST summary in that same captured output, which is what a forward scan
// would have returned -- the reason the scan runs backwards.
const capturedFirst = (() => {
	const lines = CAPTURED_OUTPUT.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line);
			if (Array.isArray(parsed.importedNames)) return parsed;
		} catch {
			// Not our summary.
		}
	}
	return null;
})();
check("a forward scan would have returned the WRONG summary", capturedFirst !== null);
if (capturedFirst !== null && capturedLast !== null) {
	check(
		capturedFirst.vertexTotal !== capturedLast.vertexTotal,
		`the captured output no longer distinguishes the two summaries (${capturedFirst.vertexTotal} vs ${capturedLast.vertexTotal}), so it no longer tests the backwards scan`,
	);
}

// ---------------------------------------------------------------------------
// A CONTRACT FIXTURE, not a captured stdout.
//
// The exact shape import_fbx.py prints. The VALUES are modelled on a real
// Chiffon avatar transfer -- the four FBX names are the files that transfer
// staged, and the three armatures are the ones blender_scene_info then
// measured (186/68/109 bones) -- but this is a RECONSTRUCTION: it was written
// from what the parser is supposed to accept, so it is a round trip of the
// parser's own contract.
//
// CONSEQUENCE, stated plainly: this fixture CANNOT detect a change in Blender's
// output format or in what the Python scripts print. If Blender renames a key,
// or starts emitting a different shape, this fixture keeps passing, because it
// only ever encodes the parser's own beliefs. That is precisely what CAPTURED_
// OUTPUT above is for, and why both exist.
//
// What the reconstruction DOES buy, and the reason it stays: it carries every
// key the script emits, so adding a key to the Python side is a key this
// fixture is expected to grow -- which is the regression this whole file
// exists for (importedFiles and armatures were printed by the script, declared
// in the interface, and dropped by the parser's return literal).
const REAL_OUTPUT = [
	"Blender 5.2.0 LTS",
	'{"importedNames": ["Armature", "Armature.001", "Armature.002", "Body", "ICO球"], "materialNames": ["Material.002", "Body", "Costume"], "collectionName": "Pi_Imported", "vertexTotal": 46993, "importedFiles": ["Chiffon_ver1.0.0.fbx", "PcHair.fbx", "Serenity_LC.fbx", "zig.fbx"], "armatures": ["Armature", "Armature.001", "Armature.002"], "flippedRoots": []}',
	"Info: Saved \"model.blend\"",
].join("\n");

const parsed = parseImportSummary(REAL_OUTPUT);

check("a real summary parses", parsed !== null);
if (parsed !== null) {
	// THE regression. These three are exactly what was being dropped.
	eq("importedFiles survive parsing", parsed.importedFiles, [
		"Chiffon_ver1.0.0.fbx",
		"PcHair.fbx",
		"Serenity_LC.fbx",
		"zig.fbx",
	]);
	eq("armatures survive parsing", parsed.armatures, ["Armature", "Armature.001", "Armature.002"]);
	eq("flippedRoots survive parsing", parsed.flippedRoots, []);

	// Every key the script prints must be present, not merely declared. A missing
	// key here is the exact failure, so assert the whole shape.
	eq(
		"the parser returns every key import_fbx.py prints",
		Object.keys(parsed).sort(),
		["armatures", "collectionName", "flippedRoots", "importedFiles", "importedNames", "materialNames", "vertexTotal"],
	);

	eq("importedNames survive parsing", parsed.importedNames, ["Armature", "Armature.001", "Armature.002", "Body", "ICO球"]);
	eq("materialNames survive parsing", parsed.materialNames, ["Material.002", "Body", "Costume"]);
	eq("collectionName survives parsing", parsed.collectionName, "Pi_Imported");
	eq("vertexTotal survives parsing", parsed.vertexTotal, 46993);
}

// Optional fields missing from the wire must become EMPTY ARRAYS, never
// undefined: the caller spreads them into accumulators.
const MINIMAL = '{"importedNames": ["Cube"], "materialNames": [], "collectionName": "Pi_Imported", "vertexTotal": 8}';
const minimal = parseImportSummary(MINIMAL);
check("a summary without the optional keys still parses", minimal !== null);
if (minimal !== null) {
	eq("absent importedFiles become []", minimal.importedFiles, []);
	eq("absent armatures become []", minimal.armatures, []);
	eq("absent flippedRoots become []", minimal.flippedRoots, []);
}

// An empty import is a legitimate outcome, not a parse failure.
const EMPTY = '{"importedNames": [], "materialNames": [], "collectionName": "Pi_Imported", "vertexTotal": 0, "importedFiles": [], "armatures": []}';
const empty = parseImportSummary(EMPTY);
check("an empty import parses rather than returning null", empty !== null);
if (empty !== null) {
	eq("empty import keeps an empty name list", empty.importedNames, []);
	eq("empty import keeps an empty file list", empty.importedFiles, []);
}

// No summary at all must stay null so the caller can raise its own error.
check("unrelated stdout yields null", parseImportSummary("nothing here\n{ not json }") === null);
check("empty stdout yields null", parseImportSummary("") === null);

// Backwards scan: when two summaries appear, the LAST one wins, because
// Blender's chatter and any earlier run can precede the current output.
const TWO = [
	'{"importedNames": ["First"], "materialNames": [], "collectionName": "C", "vertexTotal": 1, "importedFiles": ["a.fbx"], "armatures": []}',
	'{"importedNames": ["Second"], "materialNames": [], "collectionName": "C", "vertexTotal": 2, "importedFiles": ["b.fbx"], "armatures": []}',
].join("\n");
const last = parseImportSummary(TWO);
check("the last summary wins", last !== null && last.importedNames[0] === "Second");
if (last !== null) {
	eq("the last summary's files are the ones reported", last.importedFiles, ["b.fbx"]);
}

// ---------------------------------------------------------------------------
// parseExportSummary: the Blender -> Unity direction.
//
// Same class of defect, opposite route. The parser accepted any line whose
// materialNames was an array and whose vertexTotal was typeof "number", then
// returned `vertexTotal: exported?.vertexTotal ?? 0`. So a summary that was
// missing entirely, or malformed, became a CONFIDENT 0 -- and the result field
// is read as "the mesh was empty", which is a claim about the user's model that
// the binder cannot make. SKILL.md warns about this exact trap
// ("a zero means the field was dropped, not that the mesh was empty"); the
// warning was documented but the code contradicted it.
// ---------------------------------------------------------------------------

// What export_fbx.py actually prints, on one line.
const EXPORT_OK =
	'{"fbxPath": "/tmp/model.fbx", "objectNames": ["Cube", "Curve"], "materialNames": ["CurveMat", "Wood"], "textureNames": ["wood.png"], "vertexTotal": 21}';

const exportOk = parseExportSummary(EXPORT_OK);
check("a real export summary parses", exportOk !== null);
if (exportOk !== null) {
	eq("export objectNames survive parsing", exportOk.objectNames, ["Cube", "Curve"]);
	eq("export materialNames survive parsing", exportOk.materialNames, ["CurveMat", "Wood"]);
	eq("export textureNames survive parsing", exportOk.textureNames, ["wood.png"]);
	eq("export vertexTotal survives parsing", exportOk.vertexTotal, 21);
}

// A GENUINELY empty selection still reports 0, and must keep reporting it.
// This is why the fix cannot be "treat 0 as unknown": 0 is a real answer here,
// and null is the answer for the case where nothing was reported at all.
const exportEmpty = parseExportSummary(
	'{"fbxPath": "/tmp/none.fbx", "objectNames": [], "materialNames": [], "textureNames": [], "vertexTotal": 0}',
);
check("an empty export parses rather than being called malformed", exportEmpty !== null);
if (exportEmpty !== null) {
	eq("an empty export reports a real zero", exportEmpty.vertexTotal, 0);
}

// Every way the OLD check let a bogus summary through.
check("a missing vertexTotal is not a summary", parseExportSummary('{"objectNames": ["Cube"], "materialNames": []}') === null);
check(
	"a string vertexTotal is not a summary",
	parseExportSummary('{"objectNames": ["Cube"], "materialNames": [], "vertexTotal": "21"}') === null,
);
check(
	"NaN cannot survive as a count",
	parseExportSummary('{"objectNames": ["Cube"], "materialNames": [], "vertexTotal": NaN}') === null,
	"JSON.parse turns NaN into null, so this checks the null path",
);
check(
	"a negative vertexTotal is not a count",
	parseExportSummary('{"objectNames": ["Cube"], "materialNames": [], "vertexTotal": -5}') === null,
	"the old typeof check accepted -5 and reported it as a real count",
);
check(
	"a missing objectNames is not a summary",
	parseExportSummary('{"materialNames": [], "vertexTotal": 3}') === null,
	"the old check returned objectNames: [] for this, a shape export_fbx.py never prints",
);
check(
	"a non-array objectNames is not a summary",
	parseExportSummary('{"objectNames": "Cube", "materialNames": [], "vertexTotal": 3}') === null,
	"the old check returned objectNames: [] for this too",
);
check("unrelated stdout yields null", parseExportSummary("nothing here\n{ not json }") === null);
check("empty stdout yields null", parseExportSummary("") === null);

// A malformed LAST line must not hide a good earlier one -- the backwards scan
// is what makes that work, and it is the reason a tightened check is safe.
check(
	"a good summary before a malformed one still parses",
	parseExportSummary(`${EXPORT_OK}\n{"objectNames": "broken"}`) !== null,
);
check("the last VALID summary wins", (() => {
	const two = parseExportSummary(
		[
			EXPORT_OK,
			'{"fbxPath": "/tmp/b.fbx", "objectNames": ["Second"], "materialNames": [], "textureNames": [], "vertexTotal": 2}',
		].join("\n"),
	);
	return two !== null && two.objectNames[0] === "Second";
})());

// ---------------------------------------------------------------------------
// readBridgeLock: a lock that exists but does not parse is still a HELD lock.
//
// This is the same defect the unity repo had. readBridgeLock caught everything
// and returned null on a parse failure, and unity_blender_status derives `busy`
// from `lock !== null` -- so a truncated lock, which is exactly what a process
// killed mid-transfer leaves behind, was reported as "both bridges are reachable
// and idle". The next transfer then serializes behind the corpse anyway, after
// a long wait, with no explanation.
// ---------------------------------------------------------------------------
const { readBridgeLock } = await loadTs("binder/bridge.ts");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const bridgeDir = mkdtempSync(join(tmpdir(), "pi-binder-lock-"));
try {
	check("no lock at all reads as no lock", readBridgeLock(bridgeDir) === null);

	writeFileSync(join(bridgeDir, "bridge.lock"), JSON.stringify({ pid: 4242, label: "in-flight", acquiredAt: "2026-01-01T00:00:00.000Z" }));
	const held = readBridgeLock(bridgeDir);
	check("a held lock is reported", held !== null);
	check("a held lock carries its pid", held?.pid === 4242, String(held?.pid));
	check("a held lock carries its label", held?.label === "in-flight", String(held?.label));
	check("a held lock is not flagged unreadable", held?.unreadable === false, String(held?.unreadable));

	writeFileSync(join(bridgeDir, "bridge.lock"), "{corrupt");
	const corrupt = readBridgeLock(bridgeDir);
	check("a corrupt lock is still a held lock", corrupt !== null, "collapsed to null");
	check("a corrupt lock is flagged unreadable", corrupt?.unreadable === true, String(corrupt?.unreadable));
	check("a corrupt lock still carries an age, so staleness is judgeable", typeof corrupt?.ageMs === "number");

	writeFileSync(join(bridgeDir, "bridge.lock"), "");
	const empty = readBridgeLock(bridgeDir);
	check("an empty lock file is still a held lock", empty?.unreadable === true, String(empty?.unreadable));

	rmSync(join(bridgeDir, "bridge.lock"), { force: true });
	check("removing the lock clears it", readBridgeLock(bridgeDir) === null);
} finally {
	rmSync(bridgeDir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failures.length} failed (parse summary + export summary + bridge lock)`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
