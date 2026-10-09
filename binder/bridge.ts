/**
 * A minimal client for *both* live bridges.
 *
 * The binder deliberately reimplements the file-queue protocol instead of
 * importing pi-blender / pi-unity internals:
 *   - the two bridges use different request/response shapes and different
 *     environment variables, so one shared queue client is all they have in
 *     common anyway;
 *   - depending on another extension's source would couple the binder's
 *     lifetime to that extension's file layout, and either one can be upgraded
 *     or removed independently.
 *
 * The wire protocol is identical in both (a `.json` file dropped into
 * `requests/`, a matching `responses/<id>.json` coming back), so it is written
 * once here and used for both.
 */

import type { Dirent } from "node:fs";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
	BRIDGE_COLD_START_TIMEOUT_MS,
	BRIDGE_LOCK_STALE_MS,
	BRIDGE_POLL_MS,
	BRIDGE_TIMEOUT_MS,
	getHeartbeatPath,
	getStaleHeartbeatMs,
} from "../config.js";

export type BridgeName = "blender" | "unity";

export interface BridgeRequestOptions {
	/** Bridge to talk to. */
	bridge: BridgeName;
	bridgeDir: string;
	payload: Record<string, unknown>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Included in the lock file so a stuck request names its own caller. */
	label?: string;
}

export interface BridgeLockInfo {
	pid: number;
	label: string;
	acquiredAt: string;
	ageMs: number;
	/** The lock file exists but its contents did not parse. See readBridgeLock. */
	unreadable: boolean;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			rejectPromise(new Error("Aborted."));
		};
		if (signal?.aborted) {
			clearTimeout(timer);
			rejectPromise(new Error("Aborted."));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** A bridge is alive if its heartbeat file was touched recently. */
export function isBridgeAlive(bridgeDir: string): boolean {
	try {
		return Date.now() - statSync(getHeartbeatPath(bridgeDir)).mtimeMs < getStaleHeartbeatMs();
	} catch {
		return false;
	}
}

/**
 * Reads a bridge lock without mutating it.
 *
 * A lock file that exists but does not parse is still a HELD lock, so it must
 * not collapse to null: `unity_blender_status` derives "busy" from this, and
 * reporting idle while a transfer is in flight is exactly the wrong answer -- the
 * caller would then start a second transfer against the same live editor, and
 * both bridges serialize their requests anyway. A truncated lock is what a
 * crashed process leaves behind, and acquireBridgeLock reclaims it on the stale
 * threshold, so all this can do safely is report it honestly.
 */
export function readBridgeLock(bridgeDir: string): BridgeLockInfo | null {
	const lockPath = join(bridgeDir, "bridge.lock");
	let mtimeMs: number;
	try {
		mtimeMs = statSync(lockPath).mtimeMs;
	} catch {
		return null;
	}
	const ageMs = Date.now() - mtimeMs;
	try {
		const raw = JSON.parse(readFileSync(lockPath, "utf8")) as {
			pid?: number;
			label?: string;
			acquiredAt?: string;
		};
		return {
			pid: raw.pid ?? 0,
			label: raw.label ?? "unknown",
			acquiredAt: raw.acquiredAt ?? new Date(mtimeMs).toISOString(),
			ageMs,
			unreadable: false,
		};
	} catch {
		return {
			pid: 0,
			label: "",
			acquiredAt: new Date(mtimeMs).toISOString(),
			ageMs,
			unreadable: true,
		};
	}
}

export async function acquireBridgeLock(
	bridgeDir: string,
	options: { signal?: AbortSignal; timeoutMs?: number; label?: string } = {},
): Promise<{ release: () => void }> {
	const lockPath = join(bridgeDir, "bridge.lock");
	const deadline = Date.now() + (options.timeoutMs ?? BRIDGE_TIMEOUT_MS);
	mkdirSync(bridgeDir, { recursive: true });

	for (;;) {
		try {
			// 'wx' fails if the file exists: the create *is* the lock.
			const fd = openSync(lockPath, "wx");
			writeFileSync(
				fd,
				JSON.stringify({
					pid: process.pid,
					label: options.label ?? "unity-blender request",
					acquiredAt: new Date().toISOString(),
				}),
			);
			return { release: () => rmSync(lockPath, { force: true }) };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			// A lock older than the stale threshold is from a process that died
			// mid-transfer; reclaim it rather than blocking forever.
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > BRIDGE_LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Another request is still running against the ${options.label ? "bridge" : "live"} editor (lock: ${lockPath}). ` +
						`Each live editor serializes requests; retry when it finishes.`,
				);
			}
			await delay(25, options.signal);
		}
	}
}

/**
 * Send one request and wait for the response. Throws with the bridge's own
 * error text when the request failed, so a C#/Python traceback reaches the
 * model verbatim instead of being flattened to "request failed".
 */
export async function requestBridge<T>(options: BridgeRequestOptions): Promise<T> {
	const requestsDir = join(options.bridgeDir, "requests");
	const responsesDir = join(options.bridgeDir, "responses");
	mkdirSync(requestsDir, { recursive: true });
	mkdirSync(responsesDir, { recursive: true });

	const lock = await acquireBridgeLock(options.bridgeDir, {
		signal: options.signal,
		label: options.label ?? String(options.payload.type ?? options.bridge),
	});
	try {
		return await runLocked<T>(options, requestsDir, responsesDir);
	} finally {
		lock.release();
	}
}

async function runLocked<T>(
	options: BridgeRequestOptions,
	requestsDir: string,
	responsesDir: string,
): Promise<T> {
	const requestId = randomUUID();
	const requestPath = join(requestsDir, `${requestId}.json`);
	const responsePath = join(responsesDir, `${requestId}.json`);
	rmSync(responsePath, { force: true });

	// Publish atomically: the editor scans the directory continuously and must
	// never see a half-written request.
	const tempPath = `${requestPath}.tmp`;
	writeFileSync(tempPath, JSON.stringify(options.payload), "utf8");
	renameSync(tempPath, requestPath);

	const coldStart = !isBridgeAlive(options.bridgeDir);
	const timeoutMs = options.timeoutMs ?? (coldStart ? BRIDGE_COLD_START_TIMEOUT_MS : BRIDGE_TIMEOUT_MS);
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			rmSync(requestPath, { force: true });
			throw new Error(`${options.bridge} bridge request aborted.`);
		}
		if (existsSync(responsePath)) {
			const raw = readFileSync(responsePath, "utf8");
			rmSync(responsePath, { force: true });
			let parsed: { ok?: boolean; result?: T; error?: string };
			try {
				parsed = JSON.parse(raw) as typeof parsed;
			} catch (error) {
				throw new Error(
					`The ${options.bridge} bridge wrote an unreadable response: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (parsed.ok) return parsed.result as T;
			throw new Error(
				parsed.error ??
					`The ${options.bridge} bridge reported a failure with no error message. Re-run with the editor's console open.`,
			);
		}
		await delay(BRIDGE_POLL_MS, options.signal);
	}

	rmSync(requestPath, { force: true });
	throw new Error(
		`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the ${options.bridge} bridge ` +
			`(request: ${String(options.payload.type ?? "unknown")}). The request was withdrawn, but the editor may ` +
			`still be finishing it. Check that ${options.bridge === "unity" ? "the Unity project is open and the pi bridge plugin compiled" : "Blender is open with the pi-blender bridge script loaded"}, then retry.`,
	);
}

/**
 * How long a staging directory must sit untouched before it is a prune target.
 *
 * 24 h, and deliberately generous: a staged FBX is a user's asset copy, and
 * the only reason to remove it is that it is never removed otherwise. A day is
 * far longer than any transfer takes (the slow path is a 300 s bridge
 * timeout), so nothing a user might still be importing by hand gets deleted,
 * while a busy machine still prunes rather than growing without bound.
 */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on how many directories one prune may remove.
 *
 * The age test alone cannot bound a single call: a cache that filled up while
 * the feature was missing has thousands of old directories, and removing them
 * all in one synchronous pass is a multi-second stall in the middle of starting
 * a transfer. The cap spreads that over many transfers. It also keeps a
 * concurrent transfer's directory safe, because a directory younger than
 * STAGING_MAX_AGE_MS is never a candidate whatever the count.
 */
export const STAGING_PRUNE_MAX_DIRS = 10;

/**
 * A fresh per-transfer staging folder under the cache.
 *
 * Prunes first. Nothing else ever removed these directories: createStagingDir
 * appends to .transfers.log and returns, so every transfer left its FBX (plus a
 * textures/ dir for the Blender -> Unity leg) in the cache forever, and the log
 * was written and never read. A cache directory that only grows is a slow disk
 * leak of copies of a user's assets.
 *
 * Pruning is best-effort and NEVER fails the transfer. A permission error or a
 * race with another process's directory is reported on stderr and ignored: the
 * caller's actual job is the transfer, and refusing to start because the
 * housekeeping could not run would be a worse outcome than a stale directory.
 */
export function createStagingDir(prefix: string, baseDir: string): string {
	const dir = mkdtempSync(join(baseDir, `${prefix}-`));
	pruneStagingDirs(baseDir);
	appendFileSync(join(baseDir, ".transfers.log"), `${new Date().toISOString()} ${dir}\n`);
	return dir;
}

/**
 * Remove staging directories that are both old enough and (past the cap) the
 * oldest of the candidates.
 *
 * Both conditions matter, and neither alone is safe:
 *   - age alone cannot bound the work done in one call;
 *   - count alone would delete a directory a transfer just created.
 * A directory is removed only when it is older than STAGING_MAX_AGE_MS AND the
 * number of candidates still within the cap has not been reached, so a
 * concurrent transfer's own directory is never a candidate at all.
 *
 * Sorted by modification time, oldest first, so the cap removes the genuinely
 * oldest rather than whatever readdirSync happened to return.
 */
export function pruneStagingDirs(baseDir: string, now: number = Date.now()): string[] {
	/** Anything readdirSync cannot see is simply nothing to prune. */
	let entries: Dirent[];
	try {
		entries = readdirSync(baseDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const candidates: { path: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		// isDirectory() first: a symlink to a directory reports isSymbolicLink(),
		// and following one would delete something outside the cache. The staging
		// dirs are always real mkdtemp directories, so requiring a real one
		// costs nothing and removes the whole class of accident.
		if (!entry.isDirectory()) continue;
		const path = join(baseDir, entry.name);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			// Vanished between readdir and stat -- another process's cleanup.
			continue;
		}
		if (now - mtimeMs > STAGING_MAX_AGE_MS) candidates.push({ path, mtimeMs });
	}
	candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const removed: string[] = [];
	for (const candidate of candidates.slice(0, STAGING_PRUNE_MAX_DIRS)) {
		try {
			rmSync(candidate.path, { recursive: true, force: true });
			removed.push(candidate.path);
		} catch (error) {
			process.stderr.write(
				`binder: could not remove stale staging directory ${candidate.path}: ${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
	}
	return removed;
}
