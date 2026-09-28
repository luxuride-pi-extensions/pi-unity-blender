/**
 * Host paths the test harness needs, resolved instead of hardcoded.
 *
 * Deliberately mirrors pi-vibe-unity/test/paths.mjs rather than importing it:
 * the two extensions are separate git repos, and one repo's test must not
 * depend on a sibling checkout existing.
 *
 * The jiti path is resolved by picking the NEWEST release directory by name, so
 * upgrading pi does not silently break the suite. If that ever resolves to a
 * release without jiti, the loader says so by name instead of failing as an
 * unresolved module -- the failure mode otherwise looks like a broken extension.
 *
 * Overridable, because the "obvious" location is not always the real one:
 *   PI_HOME          defaults to ~/.pi
 *   PI_AGENT_DIR     defaults to $PI_HOME/agent
 *   PI_INSTALL_DIR   defaults to $PI_AGENT_DIR/install
 *   PI_JITI_PATH     explicit jiti entry point
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PI_HOME = process.env.PI_HOME ?? join(homedir(), ".pi");
export const PI_AGENT_DIR = process.env.PI_AGENT_DIR ?? join(PI_HOME, "agent");
export const PI_INSTALL_DIR = process.env.PI_INSTALL_DIR ?? join(PI_AGENT_DIR, "install");

/** Newest pi release directory by name (versions sort correctly as strings). */
export function newestPiRelease() {
	const releases = join(PI_INSTALL_DIR, "releases");
	if (!existsSync(releases)) {
		throw new Error(
			`No pi install directory at ${releases}. Set PI_INSTALL_DIR, or PI_HOME if your pi ` +
				`directory is not at ~/.pi.`,
		);
	}
	const names = readdirSync(releases).filter((name) => existsSync(join(releases, name, "node_modules")));
	if (names.length === 0) {
		throw new Error(`No pi release under ${releases} contains a node_modules directory.`);
	}
	names.sort();
	const newest = names[names.length - 1];
	return join(releases, newest);
}

function resolveJiti() {
	const explicit = process.env.PI_JITI_PATH;
	if (explicit) {
		if (!existsSync(explicit)) throw new Error(`PI_JITI_PATH is set to ${explicit}, which does not exist.`);
		return explicit;
	}
	// This repo's node_modules/ holds symlinks rather than real packages, so the
	// release copy is the reliable one; the local one is a fallback for a
	// checkout that installed its own jiti.
	const candidates = [
		join(newestPiRelease(), "node_modules", "jiti", "lib", "jiti.mjs"),
		join(import.meta.dirname, "..", "node_modules", "jiti", "lib", "jiti.mjs"),
	];
	const found = candidates.find((path) => existsSync(path));
	if (!found) {
		throw new Error(
			`Could not find jiti. Looked in:\n  ${candidates.join("\n  ")}\nSet PI_JITI_PATH to point ` +
				`at it explicitly. The harness cannot load TypeScript without it (node --strip-types ` +
				`cannot resolve this project's NodeNext ".js" specifiers).`,
		);
	}
	return found;
}

export const JITI = resolveJiti();

/** Load a TypeScript module from this repo through jiti. */
export async function loadTs(relativePath) {
	const { createJiti } = await import(JITI);
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	return jiti.import(join(import.meta.dirname, "..", relativePath));
}
