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
import { randomUUID } from "node:crypto";
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
const ENV_BLENDER_BRIDGE_DIR = "PI_BLENDER_BRIDGE_DIR";
/** Matches pi-vibe-blender's ENV_BLENDER_INSTANCE_ID. */
const ENV_BLENDER_INSTANCE_ID = "PI_BLENDER_INSTANCE_ID";

/**
 * The instance that OWNS this session's Blender, i.e. the root pi process.
 *
 * Set by whichever process loads this extension FIRST in a session, and
 * inherited by every process after it. The point is ownership rather than
 * addressing: `PI_BLENDER_INSTANCE_ID` already makes every process in the
 * tree resolve one shared bridge dir, so a subagent addresses the root's
 * Blender whether or not anything records who owns it. This var records that
 * fact, so `unity_blender_status` can say "Blender instance a1b2…, owned by the
 * root session, shared by N subagents" instead of leaving the user to infer
 * from a path whether a second window is theirs or a stranger's.
 *
 * Minted here rather than read from pi, because nothing in pi's own environment
 * names the root process. First loader is the root by construction: a subagent
 * cannot exist before the session that spawned it, and pi-subagents runs
 * children in-process or as inherited-env children.
 */
const ENV_UB_ROOT_INSTANCE_ID = "PI_UB_ROOT_INSTANCE_ID";

/**
 * A usable instance id, or null.
 *
 * The id becomes a path segment, so it is validated rather than trusted: both
 * vars are plain strings anything in the environment can set, and "../.." or an
 * absolute path would redirect the bridge dir out of the cache entirely. This
 * is deliberately the same rule pi-vibe-blender's normalizeInstanceId applies —
 * the two must agree, or a value one accepts is rejected by the other and the
 * tree splits between two bridge dirs.
 */
function normalizeInstanceId(raw: string | undefined): string | null {
	const value = raw?.trim();
	if (!value) return null;
	if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) return null;
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) return null;
	return value;
}

/** Directory holding every instance's bridge dir, for diagnostics. */
export function getBlenderBridgeRootDir(): string {
	const override = process.env[ENV_BLENDER_BRIDGE_DIR]?.trim();
	if (override) return expandUserPath(override);
	return expandUserPath(join(xdgCacheHome(), "vibe-blender", "bridge"));
}

/**
 * This session's Blender instance id, published at MODULE LOAD.
 *
 * The timing is the whole point, and it is the same reason
 * pi-vibe-blender/config.ts publishes at module load rather than lazily: a
 * child is spawned from whatever the parent has already done, and a parent that
 * has not touched Blender yet has not resolved anything, so publishing on first
 * use would leave a subagent spawned early in the session free to mint its own
 * id — and its own Blender. Module load happens in the session's root process
 * before any subagent can exist, which is exactly the guarantee needed. In a
 * child it re-publishes the value it just inherited.
 *
 * Without this, the binder RESOLVED but never PUBLISHED: a process that loaded
 * it before pi-vibe-blender read the instance dir as absent and fell back to
 * the bridge ROOT, reporting the Blender bridge dead while Blender was up one
 * level down — the exact failure the comment on getBlenderBridgeDir describes,
 * reachable purely by load order.
 */
const INSTANCE_ID = resolveInstanceId();
process.env[ENV_BLENDER_INSTANCE_ID] = INSTANCE_ID;

function resolveInstanceId(): string {
	const inherited = normalizeInstanceId(process.env[ENV_BLENDER_INSTANCE_ID]);
	if (inherited) return inherited;
	// Dashes stripped, same as pi-vibe-blender, so the id reads cleanly in a
	// path and in the instance files it is written to.
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

// The root is the first loader. See ENV_UB_ROOT_INSTANCE_ID.
const ROOT_INSTANCE_ID = normalizeInstanceId(process.env[ENV_UB_ROOT_INSTANCE_ID]) ?? INSTANCE_ID;
process.env[ENV_UB_ROOT_INSTANCE_ID] = ROOT_INSTANCE_ID;

/** This session's Blender instance id — the dir it shares with every subagent. */
export function getBlenderInstanceId(): string {
	return INSTANCE_ID;
}

/** The instance id of the root process that owns this session's Blender. */
export function getRootBlenderInstanceId(): string {
	return ROOT_INSTANCE_ID;
}

/**
 * Is THIS process the root that owns the Blender?
 *
 * A pinned `PI_BLENDER_BRIDGE_DIR` is excluded, and not as a technicality: under
 * an override there is no per-instance subdir, so the user has named ONE bridge
 * deliberately — possibly to share a UI with another process — and "root" and
 * "subagent" are no longer distinguishable by path. Ownership there is a
 * property of the directory, not of the process, so claiming it would be a lie.
 */
export function isRootBlenderInstance(): boolean {
	if (process.env[ENV_BLENDER_BRIDGE_DIR]?.trim()) return false;
	return INSTANCE_ID === ROOT_INSTANCE_ID;
}

export interface BlenderInstanceOwnership {
	/** This session's instance id, and the subdir every process shares. */
	instanceId: string;
	/** The instance that owns the Blender. Equals `instanceId` in the root. */
	rootInstanceId: string;
	/** True when this process is the owner rather than one of its subagents. */
	isRoot: boolean;
	bridgeDir: string;
	bridgeRootDir: string;
	/** True when the user pinned one bridge dir by hand, disabling the scheme. */
	pinned: boolean;
}

/**
 * Who owns the Blender this session talks to.
 *
 * Reported rather than merely enforced, because the failure this exists to
 * prevent is invisible when it happens: a second window appears, both poll the
 * same dir, and which one answered a request is a race. Naming the owner in
 * `unity_blender_status` turns "is that second Blender mine?" into a comparison
 * of two ids.
 */
export function describeBlenderInstanceOwnership(): BlenderInstanceOwnership {
	return {
		instanceId: INSTANCE_ID,
		rootInstanceId: ROOT_INSTANCE_ID,
		isRoot: isRootBlenderInstance(),
		bridgeDir: getBlenderBridgeDir(),
		bridgeRootDir: getBlenderBridgeRootDir(),
		pinned: Boolean(process.env[ENV_BLENDER_BRIDGE_DIR]?.trim()),
	};
}

/**
 * The bridge dir the live Blender actually polls, which is NOT the bridge ROOT.
 *
 * pi-vibe-blender gives each pi session a private dir at
 * `<root>/<instance-id>`; the Blender it launches polls that subdir, not the
 * root. Resolving the root alone looked for a heartbeat in a directory no
 * Blender ever writes to. The symptom was specific and misleading:
 * `unity_blender_status` reported the Blender bridge DEAD and advised not to
 * transfer, while Blender was up, serving this very session, in the subdir one
 * level down -- and `unity_blender_transfer` would then have written a request
 * into the root and waited out the full cold-start timeout for a poller that did
 * not exist.
 *
 * pi-vibe-blender is deliberately NOT imported here (see the module header: the
 * binder must survive that extension being moved, upgraded, or removed), so the
 * rule is restated here instead: an explicit override is honoured exactly as
 * given, and otherwise the instance id is appended to the root. The id is
 * inherited, never minted per process (see INSTANCE_ID above), so every process
 * in one session's delegation tree -- manager and subagents alike -- resolves
 * the same dir, and a subagent of a transfer manager talks to the same Blender
 * its manager does instead of launching its own.
 */
export function getBlenderBridgeDir(): string {
	const override = process.env[ENV_BLENDER_BRIDGE_DIR]?.trim();
	if (override) return expandUserPath(override);
	const instanceId = normalizeInstanceId(process.env[ENV_BLENDER_INSTANCE_ID]);
	// Only a traversal-free id is usable as a path segment. A malformed one
	// falls back to the root, which is the same "not answering" verdict the
	// pre-instance layout produced rather than a path outside the cache.
	if (!instanceId) return getBlenderBridgeRootDir();
	return join(getBlenderBridgeRootDir(), instanceId);
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
