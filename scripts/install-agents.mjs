#!/usr/bin/env node
/**
 * Install the binder's agent template into pi's agents directory, stamping the
 * `extensions:` path for THIS machine.
 *
 * Why a script rather than a committed path: an agent template's `extensions:`
 * field takes an absolute path, and pi-subagents does not expand `~` or read
 * env vars for it (it only resolves `.`/`..` relative segments). So the tracked
 * file cannot be correct for two machines at once, and editing the tracked copy
 * to fix it puts a host path in version control.
 *
 * The tracked template therefore keeps a placeholder, and this resolves it.
 *
 *   node scripts/install-agents.mjs            # print resolved paths
 *   node scripts/install-agents.mjs --write    # actually install
 *
 * Overrides:
 *   PI_HOME         default ~/.pi
 *   PI_AGENT_DIR    default $PI_AGENT_DIR, else $PI_HOME/agent
 *   PI_TODO_ENTRY   default $PI_AGENT_DIR/npm/node_modules/@juicesharp/rpiv-todo/index.ts
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTemplate, usesTodo } from "./agent-template-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const TEMPLATES = join(EXT_ROOT, "agents");

const PI_HOME = process.env.PI_HOME ?? join(homedir(), ".pi");
const PI_AGENT_DIR = process.env.PI_AGENT_DIR ?? join(PI_HOME, "agent");

const TODO_PACKAGE = "@juicesharp/rpiv-todo";

/**
 * The todo tool is provided by a SEPARATE extension, and a foreground child does
 * not load ambient parent extensions. So a template that names `todo` in its
 * `tools:` list must also list the todo package on its `extensions:` line, or
 * the child is handed a `todo` it can never call. blender-manager documents this
 * in its own frontmatter for the same reason.
 *
 * Whether the template needs it is `usesTodo` from the SHARED checks, not a
 * hardcoded flag here: a flag is a second source of truth that can disagree
 * with the file being installed.
 */
function resolveTodoEntry() {
	const override = process.env.PI_TODO_ENTRY?.trim();
	if (override) return override;
	const candidate = join(PI_AGENT_DIR, "npm", "node_modules", TODO_PACKAGE, "index.ts");
	if (existsSync(candidate)) return candidate;
	console.error(
		`WARNING: could not find ${TODO_PACKAGE} at ${candidate}. A template that names \`todo\` ` +
			`in tools: will be installed without its provider, and the agent cannot call it.`,
	);
	problems += 1;
	return null;
}

/**
 * The extension directory pi LOADS, which is not necessarily the checkout. If
 * this repo is not installed there, say so plainly: an agent template pointing
 * at an uninstalled directory loads with no tools and fails confusingly.
 */
function resolveInstalledExtensionDir(name) {
	const installed = join(PI_AGENT_DIR, "extensions", name);
	if (existsSync(installed)) return installed;
	if (resolve(installed) === EXT_ROOT) return EXT_ROOT;
	return installed;
}

// The Unity AND Blender extensions are listed as well as the binder, and ALL
// THREE are required. A foreground child does not load ambient parent
// extensions, so a tool named in `tools:` that no listed extension registers is
// requested and never provided. The manager is useless with only half its
// toolset -- and "half" is easy to get wrong in a way nothing catches: naming
// blender_scene_info in tools: while pi-blender is absent from this list
// leaves the child holding a verification tool that no extension provides.
const extensionDirs = [
	resolveInstalledExtensionDir("unity-blender"),
	resolveInstalledExtensionDir("pi-unity-vrchat"),
	resolveInstalledExtensionDir("pi-blender"),
]
	// Drop a path that does not exist, but only if at least one does -- an
	// all-missing pair is worth warning about rather than silently trimming.
	.filter((dir) => existsSync(dir));

const targets = [
	// `unity-blender-manager.md` is deliberately NOT here. The /unity-blender
	// command session IS the manager, so there is nothing to install: a
	// spawnable copy would be a second manager whose prompt drifts from the
	// one the user is actually watching. config.ts getManagerPrompt() reads
	// the file in place instead.
	//
	// Reads reference images with `read` and needs no extension tool, so it
	// declares no `extensions:` line. It is listed here so the installer
	// owns the copy; the stamp is a no-op on a file with nothing to stamp.
	{ file: "unity-blender-reference-describer.md", extensionDir: extensionDirs.join(", ") },
];

const write = process.argv.includes("--write");
const agentDir = join(PI_AGENT_DIR, "agents");
let problems = 0;
const todoEntry = resolveTodoEntry();

/**
 * Files this repo used to install and no longer does.
 *
 * Deleting them is part of installing, not a chore alongside it. The point of
 * the change is that no spawnable `unity-blender-manager` exists any more --
 * and an installer that only ever adds files would leave the previously
 * installed copy sitting in ~/.pi/agent/agents forever, where it stays fully
 * spawnable and fully out of date. The failure is silent and nasty: the user
 * watches the todos in the command session while a stale shadow manager sits
 * there waiting to be spawned, and the two prompts disagree.
 */
const retired = ["unity-blender-manager.md"];

for (const { file, extensionDir } of targets) {
	const source = join(TEMPLATES, file);
	if (!existsSync(source)) {
		console.error(`missing template: ${source}`);
		problems += 1;
		continue;
	}

	if (!existsSync(join(EXT_ROOT, "index.ts"))) {
		console.error(`WARNING ${file}: ${EXT_ROOT} is not an extension checkout (no index.ts).`);
		problems += 1;
	}

	// Replace the placeholder rather than a literal path, so a template
	// installed on this machine never claims to be installed on another.
	const original = readFileSync(source, "utf8");
	const extensions = usesTodo(original) && todoEntry ? `${extensionDir}, ${todoEntry}` : extensionDir;
	const stamped = original.replace(/^extensions:.*$/m, `extensions: ${extensions}`);

	// The shared checks, on the STAMPED text because that is what is installed.
	// They cover both silent failures at once: a tool the prompt names but
	// tools: omits, and a tool whose extension cannot be resolved.
	for (const problem of checkTemplate(stamped, {
		isResolvable: (name) => extensionDirs.includes(resolveInstalledExtensionDir(name)),
	})) {
		console.error(`WARNING ${file}: ${problem}`);
		problems += 1;
	}

	if (usesTodo(original) && !stamped.includes(todoEntry ?? "\0")) {
		console.error(
			`WARNING ${file}: names \`todo\` in tools: but its extensions: line would not include the ` +
				`todo package, so the installed agent cannot call it.`,
		);
		problems += 1;
	}

	// The surviving-placeholder case (more than one `extensions:` line, so the
	// stamp hit the wrong one) is now reported by the shared checks above,
	// rather than by a fourth copy of it here.

	const destination = join(agentDir, file);
	if (write) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(destination, stamped);
		console.log(`wrote ${destination}  (extensions: ${extensions})`);
	} else {
		console.log(`${file} -> ${destination}\n  extensions: ${extensions}`);
	}
}

for (const file of retired) {
	const destination = join(agentDir, file);
	if (!existsSync(destination)) continue;
	if (!write) {
		console.log(`retired ${file} -> ${destination} (still installed; re-run with --write)`);
		continue;
	}
	unlinkSync(destination);
	console.log(`removed ${destination} (no longer installed; the /unity-blender session is the manager)`);
}

if (!write) {
	console.log("\ndry run. re-run with --write to install.");
}
if (problems > 0) {
	console.error(`\n${problems} problem(s) above.`);
	process.exitCode = 1;
}
