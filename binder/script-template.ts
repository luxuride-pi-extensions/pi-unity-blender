/**
 * Interpolating the Blender-side transfer scripts.
 *
 * The Blender bridge's execute-python request has no custom-argument channel:
 * it passes only OUTPUT_BLEND_PATH, WORKSPACE_PATH, and ITERATION_PATH as
 * globals, then execs the file at `userScriptPath`. So the transfer's settings
 * are written into the staged script itself, as a JSON literal, and the script
 * is read from disk fresh on every run.
 *
 * Using a placeholder (rather than string replacement of Python syntax) keeps
 * the staged script a real .py file with a valid, lintable structure.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINDER_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

const PLACEHOLDER = "__PI_BINDER_CONFIG__";

/** Read a bundled script and substitute its config placeholder. */
export function renderBinderScript(
	scriptName: "export_fbx" | "import_obj" | "import_fbx",
	config: Record<string, unknown>,
	destination: string,
): string {
	const templatePath = join(BINDER_DIR, "scripts", `${scriptName}.py`);
	const template = readFileSync(templatePath, "utf8");
	if (!template.includes(PLACEHOLDER)) {
		throw new Error(
			`${templatePath} no longer contains the ${PLACEHOLDER} placeholder; the binder cannot configure it.`,
		);
	}

	// JSON is valid Python for any value the binder passes (dicts, lists,
	// strings, numbers, bools, null), and it escapes quotes and newlines
	// correctly -- which matters because texture and object names come from the
	// user's scene.
	const literal = JSON.stringify(config, undefined, 2);
	const rendered = template.replace(PLACEHOLDER, literal);
	writeFileSync(destination, rendered, "utf8");
	return destination;
}
