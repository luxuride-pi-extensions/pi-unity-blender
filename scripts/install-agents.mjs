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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Does this template's tools: list name a tool that `todo` provides? */
function usesTodo(source) {
	const tools = /^tools:.*$/m.exec(source)?.[0] ?? "";
	return tools.split(",").some((tool) => tool.trim() === "todo");
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

// The Unity extension is listed as well as the binder, and BOTH are required.
// A foreground child does not load ambient parent extensions, so a tool named
// in `tools:` that no listed extension registers is requested and never
// provided. The manager is useless with only half its toolset.
const extensionDirs = [
	resolveInstalledExtensionDir("unity-blender"),
	resolveInstalledExtensionDir("vibe-unity"),
]
	// Drop a path that does not exist, but only if at least one does -- an
	// all-missing pair is worth warning about rather than silently trimming.
	.filter((dir) => existsSync(dir));

const targets = [
	{ file: "unity-blender-manager.md", extensionDir: extensionDirs.join(", ") },
];

const write = process.argv.includes("--write");
const agentDir = join(PI_AGENT_DIR, "agents");
let problems = 0;
const todoEntry = resolveTodoEntry();

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

	if (usesTodo(original) && !stamped.includes(todoEntry ?? "\0")) {
		console.error(
			`WARNING ${file}: names \`todo\` in tools: but its extensions: line would not include the ` +
				`todo package, so the installed agent cannot call it.`,
		);
		problems += 1;
	}

	// If the placeholder is still present after substitution, the template has
	// more than one `extensions:` line and the stamp hit the wrong one.
	if (stamped.includes("__PI_AGENT_EXTENSION_DIR__")) {
		console.error(
			`WARNING ${file}: the placeholder survived substitution; the file has more than one extensions: line.`,
		);
		problems += 1;
	}

	const destination = join(agentDir, file);
	if (write) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(destination, stamped);
		console.log(`wrote ${destination}  (extensions: ${extensions})`);
	} else {
		console.log(`${file} -> ${destination}\n  extensions: ${extensions}`);
	}
}

if (!write) {
	console.log("\ndry run. re-run with --write to install.");
}
if (problems > 0) {
	console.error(`\n${problems} problem(s) above.`);
	process.exitCode = 1;
}
