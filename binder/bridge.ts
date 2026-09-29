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

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
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

/** A fresh per-transfer staging folder under the cache. */
export function createStagingDir(prefix: string, baseDir: string): string {
	const dir = mkdtempSync(join(baseDir, `${prefix}-`));
	appendFileSync(join(baseDir, ".transfers.log"), `${new Date().toISOString()} ${dir}\n`);
	return dir;
}
