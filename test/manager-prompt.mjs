/**
 * Regression tests for the manager prompt's composition.
 *
 * The binder holds BOTH toolchains, so getManagerPrompt() returns the connector
 * prompt plus each side extension's own manager prompt, read from the installed
 * extension at runtime. Two failure modes this exists for, both silent:
 *
 *   1. A side section fails to load and the section quietly disappears. The
 *      manager keeps working, keeps spawning workers, and briefs them without
 *      that side's procedure — the user pays for it in iterations.
 *   2. The side sections load but their frontmatter survives. `tools:` and
 *      `extensions:` are a spawnable child's contract, not a system prompt's, so
 *      a stray `tools:` line in a system section is inert at best and actively
 *      misleading at worst.
 *
 * It also pins the ORDER, because the order is the precedence rule: each side's
 * header says the connector prompt above wins where they disagree, and that
 * claim is false if a side section ever lands before it.
 */

import { loadTs, PI_AGENT_DIR } from "./paths.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const { getManagerPrompt } = await loadTs("config.ts");

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(detail ? `${name} -- ${detail}` : name);
}

const prompt = getManagerPrompt();

// --- 1. the connector prompt, and its position ------------------------------

const connectorAt = prompt.indexOf("You are the Unity-Blender MANAGER");
check("connector prompt present", connectorAt >= 0);
check("no frontmatter in connector", !prompt.includes("allowedAgents: blender-worker"));

const firstHeader = prompt.indexOf("# ---- ");
check("first side header after the connector", firstHeader > connectorAt, `header at ${firstHeader}, connector at ${connectorAt}`);

// --- 2. both side sections, in the pinned order ------------------------------

// >= rather than >: the Blender header IS the first header, so the assertion
// that matters is that the first header comes after the connector, checked
// above, and that Unity follows Blender.
const blenderAt = prompt.indexOf("# ---- Blender side manager prompt");
const unityAt = prompt.indexOf("# ---- Unity side manager prompt");
check("Blender side section present", blenderAt >= firstHeader);
check("Unity side section present", unityAt > blenderAt, "Unity must follow Blender");

// --- 3. the side prompts' actual content came across, not just a header ------

check(
	"Blender side body included",
	prompt.includes("## Fan out to several workers at once"),
	"the Blender manager's fan-out section is missing",
);
check("Unity side body included", prompt.includes("## What only fails at build time"), "a Unity manager section is missing");
check(
	"Blender exchange contract included",
	prompt.includes("## STOP CONDITIONS"),
	"the brief/stop-conditions contract the Blender side briefs with is missing",
);

// --- 4. frontmatter stripped everywhere -------------------------------------

for (const [section, needle] of [
	["Blender", "acceptanceRole:"],
	["Unity", "acceptanceRole:"],
]) {
	const start = prompt.indexOf(`# ---- ${section}`);
	if (start < 0) continue;
	const end = prompt.indexOf("# ---- ", start + 1);
	const body = prompt.slice(start, end < 0 ? undefined : end);
	check(`${section} section carries no frontmatter`, !body.includes(needle), `found ${needle} in the ${section} section`);
}

// --- 5. each header states the precedence rule -------------------------------

// A fixed window, not "up to the next blank line": the title is followed by a
// blank line and THEN the sentences that matter, so slicing to the first blank
// line would read the title alone and the assertions below would be vacuous.
for (const label of ["Blender side", "Unity side"]) {
	const at = prompt.indexOf(`# ---- ${label} manager prompt`);
	if (at < 0) continue;
	const header = prompt.slice(at, at + 900);
	check(`${label} header states the connector wins`, header.includes("wins"));
	check(`${label} header says it is not a second manager`, header.includes("not as a second manager"));
}

// --- 6. no degraded notice on a working install -----------------------------

check("no load-failure notice", !prompt.includes("could not be read from"), "a side prompt failed to load");

// --- 7. a missing side degrades LOUDLY, not silently -------------------------

const sideExtensionMissing = !existsSync(join(PI_AGENT_DIR, "extensions", "pi-blender"));
if (sideExtensionMissing) {
	console.log("skipping the degraded-path check: pi-blender is not installed, so the notice in case 6 is expected.");
} else {
	const { getManagerPrompt: reload } = await loadTs("config.ts");
	process.env.PI_AGENT_DIR = join(PI_AGENT_DIR, "definitely-not-here");
	const degraded = reload();
	check("missing side names the failure", degraded.includes("could not be read from"), "a missing side section failed silently");
	check("missing side still returns the connector", degraded.includes("You are the Unity-Blender MANAGER"));
	delete process.env.PI_AGENT_DIR;
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const failure of failures) console.error(`FAIL ${failure}`);
	process.exit(1);
}
