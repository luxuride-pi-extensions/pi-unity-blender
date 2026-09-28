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

const { parseImportSummary } = await loadTs("binder/transfer.ts");

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

// The exact shape import_fbx.py prints. The VALUES are modelled on a real
// Chiffon avatar transfer -- the four FBX names are the files that transfer
// staged, and the three armatures are the ones blender_scene_info then
// measured (186/68/109 bones) -- but this is a reconstructed fixture, not a
// captured stdout. What matters is that it carries every key the script emits,
// so adding a key to the Python side is a key this fixture is expected to grow.
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

console.log(`${passed} passed, ${failures.length} failed (parse summary)`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
