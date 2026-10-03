/**
 * Host paths the test harness needs, resolved instead of hardcoded.
 *
 * Deliberately mirrors pi-unity/test/paths.mjs rather than importing it:
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
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

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

/**
 * newestPiRelease(), or undefined when there is no pi install to look at.
 *
 * A CI runner has no ~/.pi/agent/install/releases, and newestPiRelease throws
 * when it cannot find one. resolveJiti needs the answer as a candidate, not as
 * a precondition, so it asks this instead and falls through to the repo-local
 * copy.
 */
function safeNewestPiRelease() {
	try {
		return join(newestPiRelease(), "node_modules", "jiti", "lib", "jiti.mjs");
	} catch {
		return undefined;
	}
}

/**
 * jiti resolved as a module, from THIS repo.
 *
 * Resolved through the package's own exports map rather than by string
 * concatenation: "jiti/lib/jiti.mjs" is not an exported subpath, so
 * require.resolve() on it fails with ERR_PACKAGE_PATH_NOT_EXPORTED even when
 * jiti sits right there. "./package.json" IS exported, which makes it the one
 * reliable way in. Returns undefined rather than throwing, so a repo without
 * jiti falls through to the next candidate and is reported by name.
 */
function jitiFromHere() {
	try {
		const require = createRequire(join(import.meta.dirname, "..", "package.json"));
		return join(dirname(require.resolve("jiti/package.json")), "lib", "jiti.mjs");
	} catch {
		return undefined;
	}
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
		// Guarded, not called eagerly: this list is BUILT before the .find(), so
		// an installed-pi path that throws here would take the repo-local candidate
		// down with it -- and that candidate is the one a CI checkout resolves to.
		safeNewestPiRelease(),
		// node_modules resolves WALKING UP the tree, so this finds a hoisted jiti
		// as well as a nested one. Hardcoded <repo>/node_modules/jiti found
		// nothing in a plain `npm install`, which puts jiti under
		// node_modules/@earendil-works/pi-coding-agent/node_modules/, because
		// that package ships its own shrinkwrap and pins its own jiti.
		jitiFromHere(),
		join(import.meta.dirname, "..", "node_modules", "jiti", "lib", "jiti.mjs"),
	];
	const found = candidates.filter(Boolean).find((path) => existsSync(path));
	if (!found) {
		throw new Error(
			`Could not find jiti. Looked in:\n  ${candidates.filter(Boolean).join("\n  ")}\nSet PI_JITI_PATH to point ` +
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
