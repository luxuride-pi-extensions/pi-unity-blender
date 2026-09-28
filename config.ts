/**
 * Path resolution for the unity-blender binder.
 *
 * The binder is a *separate* extension on purpose: it must be installable
 * without either pi-vibe-blender or pi-vibe-unity's TypeScript internals, and
 * it must keep working if either is moved or upgraded. So it resolves both
 * bridge directories from environment variables the same way those extensions
 * publish them, and talks to both queues with its own small client.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const APP_NAME = "unity-blender";

/** Bundled skills, published to pi through the resources_discover hook. */
export function getBundledSkillsDir(): string {
	return join(EXTENSION_DIR, "skills");
}

function xdgCacheHome(): string {
	return process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

function expandUserPath(raw: string, cwd: string = process.cwd()): string {
	const value = raw.trim();
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return homedir() + value.slice(1);
	return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Matches pi-vibe-blender's ENV_BLENDER_BRIDGE_DIR. */
/** Matches pi-vibe-blender's ENV_BLENDER_BRIDGE_DIR. */
const ENV_BLENDER_BRIDGE_DIR = "PI_BLENDER_BRIDGE_DIR";
/** Matches pi-vibe-blender's ENV_BLENDER_INSTANCE_ID. */
const ENV_BLENDER_INSTANCE_ID = "PI_BLENDER_INSTANCE_ID";

/**
 * The bridge dir the live Blender actually polls, which is NOT the bridge ROOT.
 *
 * pi-vibe-blender gives each pi session a private dir at
 * `<root>/<instance-id>`; the Blender it launches polls that subdir, not the
 * root. This function used to resolve the root alone, so it looked for a
 * heartbeat in a directory no Blender ever writes to. The symptom was specific
 * and misleading: `unity_blender_status` reported the Blender bridge DEAD and
 * advised not to transfer, while Blender was up, serving this very session, in
 * the subdir one level down -- and `unity_blender_transfer` would then have
 * written a request into the root and waited out the full cold-start timeout for
 * a poller that did not exist. The recommendation text made it worse, telling
 * the user to open an editor that was already open in front of them.
 *
 * pi-vibe-blender is deliberately NOT imported here (see the module header: the
 * binder must survive that extension being moved, upgraded, or removed), so the
 * rule is restated here instead: an explicit override is honoured exactly as
 * given, and otherwise the instance id is appended to the root. The id is
 * inherited from the parent pi process rather than minted, so every process in
 * one session's delegation tree -- manager and subagents alike -- resolves the
 * same dir, and a subagent of a transfer manager talks to the same Blender its
 * manager does.
 */
export function getBlenderBridgeDir(): string {
	const override = process.env[ENV_BLENDER_BRIDGE_DIR]?.trim();
	if (override) return expandUserPath(override);
	const root = expandUserPath(join(xdgCacheHome(), "vibe-blender", "bridge"));
	const instanceId = process.env[ENV_BLENDER_INSTANCE_ID]?.trim();
	// Only a traversal-free id is usable as a path segment. A malformed one
	// falls back to the root, which is the same "not answering" verdict the
	// pre-instance layout produced rather than a path outside the cache.
	if (!instanceId || !/^[A-Za-z0-9._-]{1,64}$/.test(instanceId) || instanceId === "." || instanceId === "..") {
		return root;
	}
	return join(root, instanceId);
}

/** Matches pi-vibe-unity's ENV_UNITY_BRIDGE_DIR. */
export function getUnityBridgeDir(): string {
	return expandUserPath(
		process.env.PI_UNITY_BRIDGE_DIR?.trim() || join(xdgCacheHome(), "vibe-unity", "bridge"),
	);
}

/**
 * Staging lives in the cache, never in a project or a .blend directory: the
 * intermediate FBX/OBJ/MTL/textures are throwaway, and a user who aborts a
 * transfer must not find junk inside Assets/.
 */
export function getStagingDir(): string {
	const dir = expandUserPath(
		process.env.PI_UNITY_BLENDER_STAGING_DIR?.trim() || join(xdgCacheHome(), APP_NAME, "staging"),
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function getHeartbeatPath(bridgeDir: string): string {
	return join(bridgeDir, "heartbeat");
}

export function getStaleHeartbeatMs(): number {
	const raw = process.env.PI_UNITY_BLENDER_HEARTBEAT_STALE_MS?.trim();
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	// 10 s of silence. Long enough to survive an import or a modal dialog,
	// short enough that a closed Editor is noticed quickly.
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export const BRIDGE_POLL_MS = 200;
export const BRIDGE_TIMEOUT_MS = 30_000;
export const BRIDGE_COLD_START_TIMEOUT_MS = 120_000;
export const BRIDGE_LOCK_STALE_MS = 600_000;
