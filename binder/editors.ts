/**
 * Detecting the two editors.
 *
 * Neither editor is reliably on PATH: Blender here is a flatpak
 * (org.blender.Blender) and Unity lives in a Hub versioned directory
 * (~/Unity/Hub/Editor/<version>/Editor/Unity). A bare `commandExists("blender")`
 * probe reports both as "not installed", which is both wrong and actively
 * misleading -- it tells the user to go install something they already have.
 *
 * So each editor is detected with the same layering its own extension uses to
 * launch it: an explicit env override, the platform's canonical install
 * location, the package-manager layout, then PATH. Detection only answers "is
 * it here and how do I reach it" -- it never launches anything. A live session
 * is still what a transfer needs; a detected binary is only relevant for
 * headless or CLI use.
 */

import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { commandExists, execCommand } from "../core/exec.js";

export interface EditorDetection {
	/** True when the editor is reachable by one of the probed routes. */
	found: boolean;
	/** Which route found it, for the status report. */
	how: string;
	/** Concrete path or command, when there is one. */
	detail: string;
}

const NOT_FOUND: EditorDetection = { found: false, how: "not found", detail: "" };

function exists(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** True when `name` is runnable: an absolute path, or found on PATH. */
async function isRunnable(name: string): Promise<boolean> {
	if (name.includes("/")) return exists(name);
	// Defer to the real PATH lookup; ~/.local/bin is on PATH here but is not
	// guaranteed to be on someone else's.
	return commandExists(name);
}

/** $BLENDER_PATH, as an argv array. Mirrors pi-vibe-blender's launch parsing. */
async function blenderPathEnv(): Promise<EditorDetection | null> {
	const raw = process.env.BLENDER_PATH?.trim();
	if (!raw) return null;
	const command = raw.split(/\s+/).filter(Boolean)[0];
	if (!command) return null;
	// Validate the command itself, not just the env var being non-empty: an
	// unset PATH would otherwise make every detection report "installed".
	return (await isRunnable(command)) ? { found: true, how: "$BLENDER_PATH", detail: raw } : null;
}

export async function detectBlender(): Promise<EditorDetection> {
	const fromEnv = await blenderPathEnv();
	if (fromEnv) return fromEnv;

	// macOS canonical location.
	const macApp = "/Applications/Blender.app/Contents/MacOS/Blender";
	if (exists(macApp)) {
		return { found: true, how: "macOS app bundle", detail: macApp };
	}

	// flatpak: a successful `info` is the same signal pi-vibe-blender uses to
	// decide it can launch Blender, and avoids launching the app to find out.
	const flatpak = await execCommand("flatpak", ["info", "--show-ref", "org.blender.Blender"], homedir(), {
		timeout: 5_000,
	});
	if (flatpak.code === 0) {
		return {
			found: true,
			how: "flatpak",
			detail: "org.blender.Blender",
		};
	}

	if (await commandExists("blender")) {
		return { found: true, how: "PATH", detail: "blender" };
	}
	return NOT_FOUND;
}

export async function detectUnity(): Promise<EditorDetection> {
	const env = process.env.UNITY_PATH?.trim();
	if (env) {
		const command = env.split(/\s+/).filter(Boolean)[0] ?? "";
		return (await isRunnable(command))
			? { found: true, how: "$UNITY_PATH", detail: env }
			: { found: false, how: "$UNITY_PATH (unrunnable)", detail: env };
	}

	const macHub = "/Applications/Unity/Hub/Editor";
	if (exists(macHub)) {
		return { found: true, how: "macOS Hub install", detail: macHub };
	}

	// Hub layout. Sort descending so the newest version wins, which is what the
	// Unity extension's own launcher does.
	const hubRoot = process.env.UNITY_HUB_PATH?.trim() || join(homedir(), "Unity", "Hub", "Editor");
	try {
		const versions = readdirSync(hubRoot)
			.filter((entry) => {
				try {
					return statSync(join(hubRoot, entry)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort()
			.reverse();
		for (const version of versions) {
			const binary = join(hubRoot, version, "Editor", "Unity");
			if (exists(binary)) {
				return { found: true, how: "Unity Hub", detail: binary };
			}
		}
	} catch {
		// No Hub directory; fall through to PATH.
	}

	if (await commandExists("unity")) {
		return { found: true, how: "PATH", detail: "unity" };
	}
	return NOT_FOUND;
}
