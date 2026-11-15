/**
 * Where the Blender-side transfer templates live.
 *
 * The three scripts this package stages (`export_fbx`, `import_obj`,
 * `import_fbx`) import `bpy`, so they are GPL-3.0-or-later and cannot ship in
 * an MIT package -- see the License section of the README and the reasoning in
 * the bridge repository. They live in `blender/binder/` inside
 * `@luxuride-pi/blender-bridge`, which is the same package `@luxuride-pi/blender`
 * already needs in order to launch Blender at all: the binder drives that
 * bridge's execute-python request, so this package never worked without it.
 *
 * The resolution order and the environment variable are deliberately identical
 * to `config.ts` in `@luxuride-pi/blender`, so ONE bridge installation serves
 * both extensions and a user who fixes one error message fixes both. The
 * duplication is the price of the two packages not depending on each other;
 * if the order changes, it has to change in both files.
 *
 * Nothing resolves at import time: a missing bridge must surface as this tool's
 * error, not as a failed extension load.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The GPL package that carries every `bpy` script in this family. */
export const BRIDGE_PACKAGE_NAME = "@luxuride-pi/blender-bridge";

/** Point this at a bridge checkout that is not where the resolver looks. */
export const ENV_BRIDGE_ASSETS_DIR = "PI_BLENDER_BRIDGE_ASSETS_DIR";

const BINDER_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(BINDER_DIR, "..");

/** The template the binder is configured for, used as the presence probe. */
const PROBE = join("blender", "binder", "export_fbx.py");

let cachedPackageDir: string | undefined;

function expandOverride(override: string): string {
	if (override === "~") return homedir();
	if (override.startsWith("~/")) return join(homedir(), override.slice(2));
	return resolve(override);
}

function hasTemplates(dir: string): boolean {
	return existsSync(join(dir, PROBE));
}

function describeCandidates(): string[] {
	return [
		`${ENV_BRIDGE_ASSETS_DIR} (currently unset)`,
		`node_modules/${BRIDGE_PACKAGE_NAME}`,
		join(PACKAGE_DIR, "..", "pi-blender-bridge"),
		join(PACKAGE_DIR, "..", "blender-bridge"),
		join(homedir(), ".pi", "agent", "extensions", "blender-bridge"),
		join(homedir(), ".pi", "agent", "extensions", "pi-blender-bridge"),
	];
}

/**
 * The bridge package root (the directory containing `blender/`).
 *
 * `PI_BLENDER_BRIDGE_ASSETS_DIR` is authoritative: when it is set to a
 * directory without the templates, that is an error rather than a reason to
 * fall through, because silently using a different copy than the one the user
 * pointed at is how "it works on my machine" gets built.
 */
export function resolveBridgePackageDir(): string {
	if (cachedPackageDir) return cachedPackageDir;

	const override = process.env[ENV_BRIDGE_ASSETS_DIR];
	if (override) {
		const expanded = expandOverride(override);
		if (!hasTemplates(expanded)) {
			throw new Error(
				`${ENV_BRIDGE_ASSETS_DIR} is set to ${expanded}, but there is no blender/binder/export_fbx.py there. ` +
					`Point it at the ${BRIDGE_PACKAGE_NAME} package root, or unset it to resolve the package normally.`,
			);
		}
		cachedPackageDir = expanded;
		return cachedPackageDir;
	}

	const candidates: string[] = [];
	try {
		const require = createRequire(import.meta.url);
		candidates.push(dirname(require.resolve(`${BRIDGE_PACKAGE_NAME}/package.json`)));
	} catch {
		// Not installed into node_modules: not on npm, so this is the unusual path.
	}
	candidates.push(
		join(PACKAGE_DIR, "..", "pi-blender-bridge"),
		join(PACKAGE_DIR, "..", "blender-bridge"),
		join(homedir(), ".pi", "agent", "extensions", "blender-bridge"),
		join(homedir(), ".pi", "agent", "extensions", "pi-blender-bridge"),
	);

	for (const candidate of candidates) {
		if (hasTemplates(candidate)) {
			cachedPackageDir = candidate;
			return cachedPackageDir;
		}
	}

	throw new Error(
		`The Blender transfer templates are not installed: ${BRIDGE_PACKAGE_NAME} was not found. ` +
			`Get it (git clone --depth 1 https://github.com/luxuride-pi-extensions/pi-blender-bridge next to this ` +
			`checkout, or unpack the release asset named there), or set ${ENV_BRIDGE_ASSETS_DIR} to the package root. ` +
			`It is a separate package because the Python is GPL-3.0-or-later, not MIT. Tried: ${describeCandidates().join(", ")}.`,
	);
}

/** The directory holding `export_fbx.py`, `import_obj.py`, and `import_fbx.py`. */
export function binderScriptsDir(): string {
	return join(resolveBridgePackageDir(), "blender", "binder");
}

/** Absolute path to one of the three templates. */
export function binderScriptPath(name: "export_fbx" | "import_obj" | "import_fbx"): string {
	return join(binderScriptsDir(), `${name}.py`);
}
