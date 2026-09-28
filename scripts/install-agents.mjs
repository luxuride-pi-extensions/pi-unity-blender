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
 * Backticked snake_case words in a prompt body that are NOT tool names.
 *
 * The scan below cannot tell a tool from a literal, and the todo task statuses
 * are the one place a prompt is obliged to quote a snake_case value: a manager
 * told to mark a task `in_progress` is quoting the value it must pass to `todo`,
 * not naming a tool it forgot. Flagging that produces a warning on a correct
 * template, which trains the reader to ignore warnings.
 */
const KNOWN_NON_TOOL_WORDS = new Set(["in_progress"]);

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
	return namesTool(source, "todo");
}

/** Does this template's tools: list name the given tool? */
function namesTool(source, name) {
	const tools = /^tools:.*$/m.exec(source)?.[0] ?? "";
	return tools.split(",").some((tool) => tool.trim() === name);
}

/**
 * Does the prompt body tell the agent to call a tool that tools: omits?
 *
 * `tools` is a STRICT allowlist (pi-subagents/docs/agents.md), so a tool named
 * in the prompt but absent from it is silently unavailable -- the agent is
 * handed a call it cannot make, with no error anywhere. That is the same
 * failure this file already guards against on the extensions: axis, and it is
 * worse here, because the prompt makes such a call MANDATORY. A manager told to
 * verify a transfer with blender_scene_info, and not given it, either skips the
 * only defense against a silent geometry loss or wastes a turn discovering it.
 *
 * The candidate scan is deliberately narrow. Pi tool names are snake_case with
 * an underscore (unity_scene_info, blender_scene_info); tool PARAMETERS are
 * camelCase or a bare lowercase word (objectNames, saveAfter, mode). Requiring
 * an underscore is what separates the two, and it is why this does not fire on
 * every parameter name in the prose. It only sees BACKTICKED names, so a tool
 * referenced in plain prose is not checked -- a known gap, accepted because a
 * looser rule produces more noise than signal.
 */
function toolsMissingFromAllowlist(source) {
	const declared = new Set(
		(/^tools:.*$/m.exec(source)?.[0] ?? "")
			.split(":")[1]
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean),
	);
	const body = source.replace(/^---[\s\S]*?\n---\n/, "");
	const mentioned = new Set();
	for (const [, name] of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
		mentioned.add(name);
	}
	return [...mentioned].filter((name) => !declared.has(name) && !KNOWN_NON_TOOL_WORDS.has(name));
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
// blender_scene_info in tools: while vibe-blender is absent from this list
// leaves the child holding a verification tool that no extension provides.
const extensionDirs = [
	resolveInstalledExtensionDir("unity-blender"),
	resolveInstalledExtensionDir("vibe-unity"),
	resolveInstalledExtensionDir("vibe-blender"),
]
	// Drop a path that does not exist, but only if at least one does -- an
	// all-missing pair is worth warning about rather than silently trimming.
	.filter((dir) => existsSync(dir));

const targets = [
	{ file: "unity-blender-manager.md", extensionDir: extensionDirs.join(", ") },
	// Reads reference images with `read` and needs no extension tool, so it
	// declares no `extensions:` line. It is listed here so the installer
	// owns the copy; the stamp is a no-op on a file with nothing to stamp.
	{ file: "unity-blender-reference-describer.md", extensionDir: extensionDirs.join(", ") },
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

	// The transpose of the tools:/extensions: guard: a tool that needs a
	// provider the extensions: line does not list. prefix-matched because the
	// tool names carry the application name.
	for (const [prefix, extension] of [
		["unity_", "vibe-unity"],
		["blender_", "vibe-blender"],
	]) {
		const declaredTools = (/^tools:.*$/m.exec(original)?.[0] ?? "").split(":")[1];
		if (
			declaredTools?.split(",").some((tool) => tool.trim().startsWith(prefix)) &&
			!extensionDirs.includes(resolveInstalledExtensionDir(extension))
		) {
			console.error(
				`WARNING ${file}: tools: names a ${prefix}* tool but the ${extension} extension is not ` +
					`resolvable, so the installed agent cannot call it.`,
			);
			problems += 1;
		}
	}

	const missingTools = toolsMissingFromAllowlist(original);
	if (missingTools.length > 0) {
		console.error(
			`WARNING ${file}: the prompt tells the agent to call ${missingTools.join(", ")}, which ` +
				`tools: does not list. tools: is a strict allowlist, so the installed agent will not ` +
				`have them. Add each to tools:.`,
		);
		problems += 1;
	}

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
