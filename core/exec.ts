/**
 * Process helper for the binder.
 *
 * The binder does not actually spawn Blender or Unity itself — it hands work to
 * whichever live session is already open. It only needs one thing from a
 * subprocess: detecting whether an editor binary exists, so a transfer can fail
 * with "Blender is not running" instead of timing out for 120 s.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options: ExecOptions = {},
): Promise<ExecResult> {
	return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
		if (options.signal?.aborted) {
			rejectPromise(new Error("Aborted before starting."));
			return;
		}

		// shell:false so a wrapper command's argv is passed through verbatim.
		const child = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let spawnError: Error | undefined;

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const killTimer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
		}, options.timeout ?? 10_000);

		const onAbort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const settle = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolvePromise(result);
		};

		// 'error' and 'close' can both fire; one settled flag keeps a failed exec
		// from being reported twice.
		child.on("error", (error: NodeJS.ErrnoException) => {
			spawnError = error;
		});
		child.on("close", (code) => {
			settle({
				stdout,
				stderr,
				// 127 is the conventional "command not found". Without this an
				// ENOENT spawn (code null, killed false) would look like success.
				//
				// A null code with no spawn error means the process died on a
				// signal rather than exiting, so 1; there is no `?? 0` here,
				// because a signal death is a failure and reporting it as success
				// is what a caller's `code !== 0` check cannot catch.
				code: spawnError ? 127 : (code ?? 1),
				killed: code === null,
			});
		});
	});
}

/** True when `command` resolves on PATH. Cheap enough to call per transfer. */
export async function commandExists(command: string): Promise<boolean> {
	const result = await execCommand(command, ["--version"], process.cwd(), { timeout: 5_000 });
	return result.code !== 127;
}
