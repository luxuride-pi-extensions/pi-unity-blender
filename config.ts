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

import { loadManagerCore } from "./manager-core.js";

/**
 * The shared core, or this extension's own copy of it.
 *
 * Resolved at module load because every function below runs while the extension
 * is being evaluated, including the instance-id publication further down. A lazy
 * resolve would leave the paths above it and the paths below it using two
 * different definitions of "where pi keeps its extensions", which is how a
 * binder ends up reading a side prompt from one install and a bridge dir from
 * another.
 */
const core = loadManagerCore();

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const APP_NAME = "unity-blender";

/** Bundled skills, published to pi through the resources_discover hook. */
export function getBundledSkillsDir(): string {
	return join(EXTENSION_DIR, "skills");
}

/**
 * The manager's own prompt, as a system-prompt section.
 *
 * /unity-blender does not spawn a manager: the command session IS the
 * manager, so its progress and todos are the ones the user is watching. The
 * prompt therefore has to reach the session that ran the command, and
 * `before_agent_start` is the only route -- pi's RegisteredCommand has no way
 * to spawn an agent (types.d.ts: name, sourceInfo, description,
 * getArgumentCompletions, handler).
 *
 * Read from the file rather than inlined, so the manager prompt stays one
 * editable markdown source instead of a 294-line string literal. The file is
 * deliberately NOT installed as an agent template, so nothing can spawn it and
 * the shadow copy that would drift cannot exist.
 *
 * Frontmatter is stripped: the `tools:` and `extensions:` lines are an agent
 * template's contract, and a command session gets its tools from the extension
 * it is already running, so a stray `tools:` line in a system prompt is both
 * inert and misleading. A missing or unreadable file yields a string that says
 * so, because a manager that silently runs on a few lines of generic guidance
 * is worse than one that reports the prompt is gone.
 *
 * What this returns is the CONNECTOR prompt followed by both side prompts, so
 * the one manager that holds both toolchains briefs from the same procedures its
 * own side's manager uses. See readSideManagerPrompts() for why the side
 * sections are included whole and wrapped rather than summarized.
 */
export function getManagerPrompt(): string {
	return core.composeManagerPrompt({
		connectorPath: join(EXTENSION_DIR, "agents", "unity-blender-manager.md"),
		connectorRole: "unity-blender manager",
		sides: SIDE_MANAGER_PROMPTS,
	});
}

/**
 * The side prompts this manager runs on, and the extra file each keeps beside
 * its manager prompt. Keyed by the extension directory name pi installs, not by
 * a checkout path, so a symlinked install resolves the same as a real one.
 */
const SIDE_MANAGER_PROMPTS = [
	{
		label: "Blender side",
		extension: "vibe-blender",
		primary: join("blender", "agents", "blender-manager.md"),
		// The Blender side keeps its brief template and stop conditions in a
		// second file that its own getManagerPrompt() appends. Read it here too,
		// or this manager would brief workers without the contract that makes a
		// brief cheap to act on.
		extra: join("blender", "agents", "exchange.md"),
	},
	{ label: "Unity side", extension: "vibe-unity", primary: join("unity", "agents", "unity-manager.md"), extra: null },
] as const;

/**
 * The two side manager prompts, in full, each under a provenance header.
 *
 * This session manages both applications, so it needs both sides' procedures.
 * Copying them into the binder would be the obvious move and the wrong one:
 * they are ~370 and ~500 lines of markdown that change whenever either
 * extension is upgraded, and a copy here goes stale silently and looks
 * authoritative while doing it. Reading the installed extensions' own files is
 * the same contract getManagerPrompt() already uses for its own prompt — one
 * editable source per manager, and the binder holds the boundary rather than
 * the parts.
 *
 * The composition itself — reading a connector plus a list of sides, wrapping
 * each side under a provenance header, and degrading loudly when any of them
 * cannot be read — is now shared code in pi-manager-core, because the Unity
 * side and the Blender side each need it for their own single-side manager
 * prompt, and three copies of a precedence rule that decides which of several
 * competing managers wins is three chances to get the precedence wrong. The
 * reasoning behind the header and the whole-file inclusion is documented on
 * composeManagerPrompt() in that core.
 */

/**
 * Where pi keeps its agent directory, which is where the side extensions live.
 *
 * Overridable for the same reason the install script takes PI_AGENT_DIR: a test
 * harness and a non-default pi home both need to point somewhere else, and a
 * hardcoded ~/.pi would resolve to a real installation and read the wrong
 * extension's prompt.
 */
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
