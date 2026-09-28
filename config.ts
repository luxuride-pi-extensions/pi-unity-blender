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
import { isAbsolute, join, resolve } from "node:path";

const APP_NAME = "unity-blender";

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
export function getBlenderBridgeDir(): string {
	return expandUserPath(
		process.env.PI_BLENDER_BRIDGE_DIR?.trim() || join(xdgCacheHome(), "vibe-blender", "bridge"),
	);
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
