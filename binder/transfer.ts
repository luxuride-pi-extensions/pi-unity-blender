/**
 * The actual Blender <-> Unity transfer.
 *
 * Two legs, each with the same shape: export in the source application, stage
 * the file in the cache, import it in the destination. Nothing is ever written
 * into a user's project or .blend directory except the import result itself.
 *
 * The asymmetry is deliberate and comes from the applications, not from
 * preference:
 *
 *   Blender -> Unity   FBX. Both applications read FBX; Blender *writes* it
 *                      natively and Unity's importer handles it well, including
 *                      material slots and embedded textures.
 *   Unity -> Blender   OBJ + MTL. Blender's OBJ importer is native and stable
 *                      across versions, whereas Unity has no built-in mesh
 *                      exporter at all -- the bridge writes OBJ by hand (see
 *                      ExportObj in PiUnityBridge.cs).
 *
 * Either leg can be run without the other application installed, but BOTH legs
 * need the *bridge* alive, and both are checked up front so a missing editor
 * fails in a second instead of after a 120 s cold-start timeout.
 */

import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getBlenderBridgeDir, getStagingDir, getUnityBridgeDir } from "../config.js";
import { createStagingDir, isBridgeAlive, requestBridge } from "./bridge.js";
import { detectBlender, detectUnity, type EditorDetection } from "./editors.js";
import { renderBinderScript } from "./script-template.js";

export type TransferDirection = "blender-to-unity" | "unity-to-blender";

export interface TransferPreconditions {
	blenderBridgeAlive: boolean;
	unityBridgeAlive: boolean;
	blender: EditorDetection;
	unity: EditorDetection;
	problems: string[];
}

export interface BlenderSession {
	blendPath: string | null;
	isDirty: boolean;
	activeObject: string | null;
	selectedObjects: string[];
}

export interface UnitySession {
	projectPath: string;
	activeScene: string;
	selection: string[];
}

/** One side's live session, or the reason it could not be read. */
export type SideSession =
	| { ok: true; blender: BlenderSession }
	| { ok: true; unity: UnitySession }
	| { ok: false; error: string };

/** The message text of a thrown value, never "[object Object]". */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Both live sessions, read in parallel, each independently fallible.
 *
 * The independence is the point: a user with only Blender open must still get
 * their Blender state, and a dead bridge must not blank the other side's. A
 * Promise.all would throw away the side that worked, which is the same
 * all-or-nothing reporting the precondition checklist exists to avoid.
 *
 * `alive` gates the request rather than the report. A request to a bridge with
 * no poller takes a bridge lock and then waits out the full cold-start timeout
 * before failing, so probing one would make the cheap status call the slowest
 * call in the toolset and defeat its purpose. A side already known to be down
 * gets the reason immediately.
 *
 * A live bridge can still fail its read -- it may be mid-transfer, or the
 * request may time out -- and that failure is reported per side rather than
 * thrown, for the same independence reason.
 */
export async function readBothSessions(alive: {
	blender: boolean;
	unity: boolean;
}): Promise<{ blender: SideSession; unity: SideSession }> {
	const skip = (side: string): SideSession => ({
		ok: false,
		error: `${side} bridge is not answering, so its session state is unavailable.`,
	});
	// Written out per side rather than through a generic helper: the result is a
	// union keyed by which side produced it, and a spread of a
	// `BlenderSession | UnitySession` into a `{ ok: true }` variant is exactly
	// the cast TypeScript is right to reject -- it cannot tell which key the
	// spread produced, so a swapped side would typecheck.
	const readBlender = async (isAlive: boolean): Promise<SideSession> => {
		if (!isAlive) return skip("Blender");
		try {
			return { ok: true, blender: await readBlenderSession() };
		} catch (error) {
			return { ok: false, error: messageOf(error) };
		}
	};
	const readUnity = async (isAlive: boolean): Promise<SideSession> => {
		if (!isAlive) return skip("Unity");
		try {
			return { ok: true, unity: await readUnitySession() };
		} catch (error) {
			return { ok: false, error: messageOf(error) };
		}
	};
	const [blender, unity] = await Promise.all([
		readBlender(alive.blender),
		readUnity(alive.unity),
	]);
	return { blender, unity };
}

/**
 * Check everything that can be checked cheaply, and report all problems at
 * once. Reporting them together matters: a user who has neither bridge running
 * should learn that once, not discover the second problem after fixing the
 * first.
 */
export async function checkTransferPreconditions(
	direction: TransferDirection,
): Promise<TransferPreconditions> {
	const blenderBridgeAlive = isBridgeAlive(getBlenderBridgeDir());
	const unityBridgeAlive = isBridgeAlive(getUnityBridgeDir());
	const [blender, unity] = await Promise.all([detectBlender(), detectUnity()]);

	const problems: string[] = [];
	if (!blenderBridgeAlive) {
		problems.push(
			"Blender is not running with the vibe-blender bridge loaded. Open your .blend in Blender " +
				"(or run /blender first), then retry.",
		);
	}
	if (!unityBridgeAlive) {
		problems.push(
			"Unity is not running with a project open, or the pi bridge plugin has not compiled yet. " +
				"Open the Unity project (first open takes a minute or two), then check unity_bridge_status.",
		);
	}
	// A missing editor binary is informational, not fatal: both legs run inside
	// an already-open application, so the binary only matters for headless use.
	// Saying "not installed" when it is merely not on PATH would send the user
	// off to install what they already have.
	if (!blender.found) {
		problems.push(
			"Note: no Blender executable found by $BLENDER_PATH, the macOS app bundle, flatpak " +
				"(org.blender.Blender), or PATH. This does not block a transfer from a running Blender, " +
				"since the work happens in the live session.",
		);
	}
	if (!unity.found) {
		problems.push(
			"Note: no Unity executable found by $UNITY_PATH, the macOS Hub install, the Unity Hub " +
				"version directories, or PATH. Like Blender, a live Editor is enough for the transfer itself.",
		);
	}
	void direction;

	return { blenderBridgeAlive, unityBridgeAlive, blender, unity, problems };
}

/**
 * Read the live Blender session: which .blend is open, whether it has unsaved
 * changes, and what is selected.
 *
 * Exported, not private, because `unity_blender_status` needs the same three
 * facts and a second implementation would drift. The isDirty flag matters here
 * specifically: only what is SAVED crosses a transfer, so an open dirty .blend
 * is a request that would silently export stale geometry.
 */
export async function readBlenderSession(): Promise<BlenderSession> {
	const context = await requestBridge<{
		blendPath: string | null;
		isDirty: boolean;
		selection: { activeObject: { name: string } | null; selectedObjects: { name: string }[] };
	}>({
		bridge: "blender",
		bridgeDir: getBlenderBridgeDir(),
		payload: { type: "get-session-context" },
		label: "binder:blender-session",
	});
	return {
		blendPath: context.blendPath,
		isDirty: context.isDirty,
		activeObject: context.selection.activeObject?.name ?? null,
		selectedObjects: context.selection.selectedObjects.map((object) => object.name),
	};
}

/** Read the live Unity Editor session: project, active scene, and selection. */
export async function readUnitySession(): Promise<UnitySession> {
	const context = await requestBridge<{
		projectPath: string;
		scene: { name: string };
		selection: { gameObjects: string[] };
	}>({
		bridge: "unity",
		bridgeDir: getUnityBridgeDir(),
		payload: { type: "get-session-context" },
		label: "binder:unity-session",
	});
	return {
		projectPath: context.projectPath,
		activeScene: context.scene.name,
		selection: context.selection.gameObjects,
	};
}

export interface BlenderToUnityOptions {
	/** Limit the transfer to these Blender objects. Empty = the selection. */
	objectNames?: string[];
	/** Folder inside Assets/ to import into. */
	destination?: string;
	/** Name for the resulting prefab. Defaults to the .fbx file name. */
	name?: string;
	/** Save the .blend after exporting. */
	saveAfter?: boolean;
}

export interface BlenderToUnityResult {
	fbxPath: string;
	prefabPath: string;
	fbxAssetPath: string;
	rootName: string;
	objectNames: string[];
	materialNames: string[];
	textureNames: string[];
	vertexTotal: number;
	blenderBlendPath: string | null;
	unityScene: string;
	notes: string[];
}

export async function transferBlenderToUnity(
	options: BlenderToUnityOptions = {},
): Promise<BlenderToUnityResult> {
	const notes: string[] = [];

	const blender = await readBlenderSession();
	if (!blender.blendPath) {
		throw new Error(
			"Blender has no saved .blend open, so there is nothing to transfer from. Save the file " +
				"(File > Save As) and retry -- the binder exports through the live session, so an unsaved " +
				"document has no path to hand to Unity.",
		);
	}
	if (blender.isDirty) {
		notes.push(
			"Blender had unsaved changes when the transfer started. Only what is on disk was exported; " +
				"save in Blender first if you meant to include recent edits.",
		);
	}

	const objectNames =
		options.objectNames && options.objectNames.length > 0
			? options.objectNames
			: blender.selectedObjects;
	if (objectNames.length === 0) {
		notes.push("Nothing was selected in Blender, so every mesh object in the file was exported.");
	}

	const staging = createStagingDir("blender-to-unity", getStagingDir());
	const fbxPath = join(staging, "transfer.fbx");
	const textureDir = join(staging, "textures");
	const scriptPath = renderBinderScript(
		"export_fbx",
		{
			outPath: fbxPath,
			textureDir,
			objectNames,
		},
		join(staging, "export_fbx.py"),
	);

	// saveAfter defaults to true so the export and any layout changes are
	// consistent with the file Unity will later re-export.
	const exportRun = await requestBridge<{ stdout: string; stderr: string; exitCode: number }>({
		bridge: "blender",
		bridgeDir: getBlenderBridgeDir(),
		payload: {
			type: "execute-python",
			blendPath: blender.blendPath,
			workspacePath: dirname(blender.blendPath),
			iterationPath: staging,
			userScriptPath: scriptPath,
			saveAfter: options.saveAfter ?? true,
			label: "binder:export-fbx",
		},
		// An FBX export of a large file is legitimately slow.
		timeoutMs: 300_000,
	});

	if (!existsSync(fbxPath)) {
		throw new Error(
			`Blender reported success but wrote no FBX to ${fbxPath}. Check the Blender console for an ` +
				`importer error (an exporter add-on can be disabled).`,
		);
	}

	// The export script prints its own summary as the last line of stdout. Parse
	// it for real counts rather than reporting zeros -- but never fail the
	// transfer over it, since the FBX is already on disk and importing it is
	// the thing the user actually asked for.
	const exported = parseExportSummary(exportRun.stdout);
	if (!exported) {
		notes.push(
			"Blender did not report export statistics (its summary line was missing or unparseable), so " +
				"materialNames and vertexTotal are unknown rather than zero. The geometry still imported.",
		);
	}

	const destination = options.destination ?? "Assets/PiImported";
	const importResult = await requestBridge<{
		prefabPath: string;
		fbxAssetPath: string;
		rootName: string;
	}>({
		bridge: "unity",
		bridgeDir: getUnityBridgeDir(),
		payload: {
			type: "import-fbx",
			fbxPath,
			destination,
			name: options.name ?? "",
		},
		timeoutMs: 300_000,
		label: "binder:import-fbx",
	});

	// Re-read the session so the result reports the scene the prefab landed in,
	// not the one open before the import.
	const unity = await readUnitySession();
	notes.push(
		"Material transfer is approximate: Blender's node graph is flattened to the standard properties " +
			"the FBX format can carry, and procedural or layered materials lose their structure. Verify the " +
			"materials in Unity rather than trusting the count.",
	);

	return {
		fbxPath,
		prefabPath: importResult.prefabPath,
		fbxAssetPath: importResult.fbxAssetPath,
		rootName: importResult.rootName,
		objectNames: exported?.objectNames ?? objectNames,
		materialNames: exported?.materialNames ?? [],
		textureNames: exported?.textureNames ?? [],
		vertexTotal: exported?.vertexTotal ?? 0,
		blenderBlendPath: blender.blendPath,
		unityScene: unity.activeScene,
		notes,
	};
}

interface ExportSummary {
	objectNames: string[];
	materialNames: string[];
	textureNames: string[];
	vertexTotal: number;
}

/**
 * The export script prints one JSON object as its final stdout line. Blender may
 * interleave exporter chatter, so scan backwards for the last line that parses
 * as our summary rather than assuming the output is only that.
 */
function parseExportSummary(stdout: string): ExportSummary | null {
	const lines = stdout.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = (lines[index] ?? "").trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as Partial<ExportSummary>;
			if (Array.isArray(parsed.materialNames) && typeof parsed.vertexTotal === "number") {
				return {
					objectNames: Array.isArray(parsed.objectNames) ? parsed.objectNames : [],
					materialNames: parsed.materialNames,
					textureNames: Array.isArray(parsed.textureNames) ? parsed.textureNames : [],
					vertexTotal: parsed.vertexTotal,
				};
			}
		} catch {
			// Not our summary; keep scanning upwards.
		}
	}
	return null;
}

export interface ImportSummary {
	importedNames: string[];
	materialNames: string[];
	collectionName: string;
	vertexTotal: number;
	importedFiles?: string[];
	armatures?: string[];
	flippedRoots?: string[];
}

/**
 * Same shape as parseExportSummary, but keyed on the keys import_obj.py
 * actually prints. Scans backwards for the last line that parses, because
 * Blender's own chatter can come after the script's output.
 *
 * Exported so test/parse-summary.mjs can lock the returned shape down. When
 * this was private, a field added to the interface and read by the caller
 * could still be dropped here, and nothing failed.
 */
export function parseImportSummary(stdout: string): ImportSummary | null {
	const lines = stdout.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = (lines[index] ?? "").trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as Partial<ImportSummary>;
			// importedNames must be a real array. An empty one is a legitimate
			// "nothing landed", which the caller reports -- it is not a parse
			// failure, so it must not be confused with "no summary at all".
			if (!Array.isArray(parsed.importedNames)) continue;
			// Carry EVERYTHING the script printed. Returning only a subset here
			// made importedFiles and armatures silently empty even though the
			// script printed them, so a transfer reported "no rig came across"
			// for a file that in fact carried one.
			return {
				importedNames: parsed.importedNames,
				materialNames: Array.isArray(parsed.materialNames) ? parsed.materialNames : [],
				collectionName: typeof parsed.collectionName === "string" ? parsed.collectionName : "",
				vertexTotal: typeof parsed.vertexTotal === "number" ? parsed.vertexTotal : 0,
				importedFiles: Array.isArray(parsed.importedFiles) ? parsed.importedFiles : [],
				armatures: Array.isArray(parsed.armatures) ? parsed.armatures : [],
				flippedRoots: Array.isArray(parsed.flippedRoots) ? parsed.flippedRoots : [],
			};
		} catch {
			// Not our summary; keep scanning upwards.
		}
	}
	return null;
}

export interface UnityToBlenderOptions {
	/** GameObjects to export. Empty = the whole active scene. */
	gameObjectNames?: string[];
	/** Collection to gather the import under in Blender. */
	collectionName?: string;
	/** Flip the Y axis on import, since Unity is Y-up and Blender is Z-up. */
	flipUpAxis?: boolean;
	saveAfter?: boolean;
	/**
	 * Default true: hand over the source model file Unity itself imported
	 * (an .fbx under Assets/) instead of re-exporting OBJ. The file is both
	 * simpler and lossless, because Blender imports FBX natively. Set false to
	 * force the OBJ path -- needed for meshes with no source file on disk, and
	 * as an escape hatch when a specific FBX misbehaves.
	 */
	preferSourceModels?: boolean;
}

export interface UnityToBlenderResult {
	/** The staged OBJ. Null when the transfer handed over source model files. */
	objPath: string | null;
	/** The staged MTL. Null when the transfer handed over source model files. */
	mtlPath: string | null;
	/** The source model files copied out of the Unity project, when that path was used. */
	stagedPaths?: string[];
	/** Per-file breakdown: which sub-meshes travelled in each source model. */
	models?: { assetPath: string; objects: string[]; vertexTotal: number; boneTotal: number }[];
	/** Objects that could not be handed over because they have no source file. */
	unhandoffableObjects?: string[];
	/** Unhandoffable objects whose NAME is shared by several objects, so the OBJ fallback cannot reach them. */
	ambiguousObjectNames?: string[];
	/** True when the transfer used both routes: whole source files plus an OBJ fallback. */
	usedBothRoutes?: boolean;
	/** Names as Blender reports them after import -- NOT what Unity exported. */
	importedNames: string[];
	/** Source model files Blender actually loaded, when that path was used. */
	importedFiles?: string[];
	/** Armatures that came in with the model, when that path was used. */
	armatures?: string[];
	/** Materials Blender actually created. */
	materialNames: string[];
	collectionName: string;
	vertexTotal: number;
	/**
	 * False means the objects exist only in the live, unsaved Blender session.
	 * blender_scene_info reads the .blend from disk in a background process and
	 * therefore cannot see them until a save happens.
	 */
	saved: boolean;
	unityScene: string;
	blenderBlendPath: string | null;
	notes: string[];
}

export async function transferUnityToBlender(
	options: UnityToBlenderOptions = {},
): Promise<UnityToBlenderResult> {
	const notes: string[] = [];

	const unity = await readUnitySession();
	const blender = await readBlenderSession();
	if (!blender.blendPath) {
		throw new Error(
			"Blender has no saved .blend open, so there is nowhere to import into. Save a file in Blender " +
				"(File > Save As) and retry.",
		);
	}

	const gameObjectNames =
		options.gameObjectNames && options.gameObjectNames.length > 0
			? options.gameObjectNames
			: unity.selection;
	if (gameObjectNames.length === 0) {
		notes.push("Nothing was selected in Unity, so every root object in the active scene was exported.");
	}

	const staging = createStagingDir("unity-to-blender", getStagingDir());
	const objPath = join(staging, "transfer.obj");

	// TWO ROUTES CAN RUN IN ONE TRANSFER, and this is the reason the "prefer
	// source models" switch is not an either/or choice.
	//
	// A Unity selection routinely mixes two kinds of object: meshes that came
	// from a model file still sitting under Assets/ (an avatar, a hair FBX), and
	// meshes that have no such file (Unity's built-in primitives, procedural
	// geometry). Choosing one route drops the other kind. Choosing source
	// models alone silently lost the primitives; choosing OBJ alone threw away
	// every rig and flattened every material. So: hand over the files when they
	// exist, and export the remainder as OBJ in the same transfer.
	interface SourceModelExport {
		stagedPaths: string[];
		models?: { assetPath: string; objects: string[]; vertexTotal: number; boneTotal: number }[];
		unhandoffableObjects: string[];
		unhandoffableNames?: string[];
		unhandoffableCounts?: Record<string, number>;
	}

	const preferSourceModels = options.preferSourceModels !== false;
	let sourceExport: SourceModelExport | null = null;
	if (preferSourceModels) {
		sourceExport = await requestBridge<SourceModelExport>({
			bridge: "unity",
			bridgeDir: getUnityBridgeDir(),
			payload: { type: "export-source-models", outputDir: staging, gameObjectNames },
			timeoutMs: 300_000,
			label: "binder:export-source-models",
		});
	}

	const stagedPaths = sourceExport?.stagedPaths ?? [];
	const missingStaged = stagedPaths.filter((path) => !existsSync(path));
	if (missingStaged.length > 0) {
		throw new Error(
			"Unity reported a successful export but these staged model files do not exist: " +
				`${missingStaged.join(", ")}. Check the Unity console for a file-access error.`,
		);
	}

	// Which of the objects with no source file can the OBJ route actually reach?
	// A bare name resolves to exactly ONE GameObject, so a name shared by several
	// objects cannot be exported by name. Those are reported rather than
	// half-transferred: claiming "sphere transferred" after moving one of five
	// is worse than saying it did not go.
	const unhandoffableCounts = sourceExport?.unhandoffableCounts ?? {};
	const allUnhandoffable = sourceExport?.unhandoffableNames ?? [];
	const ambiguousNames = allUnhandoffable.filter((name) => (unhandoffableCounts[name] ?? 1) > 1);
	const objNames = allUnhandoffable.filter((name) => (unhandoffableCounts[name] ?? 1) <= 1);

	const needObjExport = !preferSourceModels || (stagedPaths.length > 0 && objNames.length > 0);

	interface ObjExport {
		objPath: string;
		mtlPath: string;
		meshNames: string[];
		materialNames: string[];
	}
	let objExport: ObjExport | null = null;
	if (needObjExport) {
		objExport = await requestBridge<ObjExport>({
			bridge: "unity",
			bridgeDir: getUnityBridgeDir(),
			payload: { type: "export-obj", outputPath: objPath, gameObjectNames: objNames },
			timeoutMs: 300_000,
			label: "binder:export-obj",
		});
		if (!existsSync(objExport.objPath)) {
			throw new Error(
				`Unity reported a successful export but no OBJ exists at ${objExport.objPath}. Check the ` +
					`Unity console for an exporter error.`,
			);
		}
	}

	// Which sub-meshes travelled that the caller did not ask for. Naming them is
	// the difference between "you get the whole file" being a stated scope and
	// it being a surprise discovered in Blender.
	const asked = new Set(gameObjectNames);
	const extraFromFiles: string[] = [];
	for (const model of sourceExport?.models ?? []) {
		for (const objectName of model.objects) {
			if (!asked.has(objectName) && !extraFromFiles.includes(objectName)) extraFromFiles.push(objectName);
		}
	}

	const collectionName = options.collectionName ?? "Pi_Imported";
	// Import each route in turn. These are separate bridge requests, but the
	// on-disk lock serialises them, and only the LAST one saves -- saving after
	// the first would persist a half-finished transfer.
	const steps: { kind: "fbx" | "obj"; config: Record<string, unknown> }[] = [];
	if (stagedPaths.length > 0) {
		steps.push({
			kind: "fbx",
			config: { fbxPaths: stagedPaths, collectionName, flipUpAxis: false },
		});
	}
	if (objExport) {
		steps.push({
			kind: "obj",
			config: {
				objPath: objExport.objPath,
				mtlPath: objExport.mtlPath,
				objectNames: objNames,
				collectionName,
				flipUpAxis: options.flipUpAxis ?? true,
			},
		});
	}
	if (steps.length === 0) {
		throw new Error(
			"Nothing to transfer: the selection resolved to neither a source model file nor a mesh with " +
				"no source file. Check unity_blender_status, and that the named objects still exist in the " +
				"open scene.",
		);
	}

	const importedNames: string[] = [];
	const materialNames: string[] = [];
	const importedFiles: string[] = [];
	const armatures: string[] = [];
	let collectionUsed = collectionName;
	let vertexTotal = 0;
	const blenderOutput: string[] = [];

	for (const [index, step] of steps.entries()) {
		const isLast = index === steps.length - 1;
		const scriptPath = renderBinderScript(
			step.kind === "fbx" ? "import_fbx" : "import_obj",
			step.config,
			join(staging, step.kind === "fbx" ? "import_fbx.py" : "import_obj.py"),
		);

		const importRun = await requestBridge<{ stdout: string; stderr: string; exitCode: number }>({
			bridge: "blender",
			bridgeDir: getBlenderBridgeDir(),
			payload: {
				type: "execute-python",
				blendPath: blender.blendPath,
				workspacePath: dirname(blender.blendPath),
				iterationPath: staging,
				userScriptPath: scriptPath,
				saveAfter: isLast && (options.saveAfter ?? true),
				label: `binder:import-${step.kind}`,
			},
			timeoutMs: 300_000,
		});

		blenderOutput.push(importRun.stdout, importRun.stderr);

		// The import script prints what ACTUALLY landed in Blender. Reporting the
		// export side's names instead meant a silently-empty import still claimed
		// success with a full-looking result, which is the one thing a transfer
		// result must never do.
		const summary = parseImportSummary(importRun.stdout);
		if (!summary) {
			throw new Error(
				`Blender ran the ${step.kind.toUpperCase()} import but reported no import summary, so the ` +
					"result cannot be confirmed. The file is still in the staging directory if you want to " +
					`import it by hand. Blender output was:\n${
						importRun.stdout.trim() || importRun.stderr.trim() || "(empty)"
					}`,
			);
		}
		importedNames.push(...summary.importedNames);
		materialNames.push(...summary.materialNames);
		importedFiles.push(...(summary.importedFiles ?? []));
		armatures.push(...(summary.armatures ?? []));
		collectionUsed = summary.collectionName;
		vertexTotal += summary.vertexTotal;
	}

	// Kept in the shape the reporting below already expects, so the two routes
	// read as one transfer to everything downstream.
	const imported = {
		importedNames,
		materialNames,
		collectionName: collectionUsed,
		vertexTotal,
		importedFiles,
		armatures,
	};

	const useSourceModels = stagedPaths.length > 0;

	// Name the files that travelled, and their size, so "it came across" is
	// checkable without leaving the result.
	const fileList = (paths: string[]): string[] =>
		paths.map((path) => `${basename(path)} (${existsSync(path) ? Math.round(statSync(path).size / 1024) : 0} KB)`);

	if (useSourceModels) {
		notes.push(
			`Handed over the source model file(s) Unity itself imported, so the geometry is not ` +
				`re-serialised a second time: ${fileList(stagedPaths).join(", ")}. Blender imports FBX ` +
				"natively, so the rig and the material description come across intact -- unlike the OBJ " +
				"path, which can only express the flat Kd/Ks/Ns/d/illum set.",
		);
		notes.push(
			"SCOPE IS THE WHOLE FILE: an FBX carries no sub-mesh selection, so everything in the file came " +
				`along${extraFromFiles.length > 0 ? ` -- you asked for ${extraFromFiles.join(", ")}, and the file also contains the rest` : ""}. ` +
				"Delete what you did not want in Blender.",
		);
		// Blender names imported objects after the FBX's own nodes, which are
		// not always the names Unity showed: Unity renames a sub-asset from the
		// file and node, and an artist may have renamed it again. A caller
		// matching names programmatically would read a rename as a failed
		// import, so say so rather than leaving it to be discovered.
		const renamed = (sourceExport?.models ?? []).filter(
			(model) => !model.objects.some((name) => imported.importedNames.includes(name)),
		);
		if (renamed.length > 0) {
			notes.push(
				"Some imported objects do not carry the names Unity showed, because Blender names them after " +
					`the FBX's own nodes. Unity asked for: ${renamed.flatMap((m) => m.objects).join(", ")}. ` +
					`Blender actually created: ${imported.importedNames.join(", ")}. The count is what to trust.`,
			);
		}
	}
	if (objExport) {
		notes.push(
			`Also exported through OBJ the ${objNames.length} object(s) that have no source model file on ` +
				`disk: ${objNames.join(", ")} -> ${fileList([objExport.objPath]).join(", ")}. Their material ` +
				`graph is flattened to the MTL property set (${objExport.materialNames.length} material(s)).`,
		);
	}
	for (const unhandoffable of sourceExport?.unhandoffableObjects ?? []) {
		notes.push(`NOT transferred (no source file on disk, so nothing to hand over): ${unhandoffable}`);
	}
	if (ambiguousNames.length > 0) {
		// The OBJ exporter resolves a GameObject NAME to a single object, so a
		// name shared by several objects cannot all be exported by name. Saying
		// so is the honest outcome; picking one silently would report a
		// transfer that moved 1 of 5 and looked complete.
		notes.push(
			`NOT transferred by name: ${ambiguousNames
				.map((name) => `${name} (x${unhandoffableCounts[name]})`)
				.join(", ")}. These names are shared by several objects, and the OBJ exporter takes one ` +
				"object per name, so exporting by name would have moved only one and reported all of them. " +
				"Give the specific object its own name, or select it alone.",
		);
	}
	if (useSourceModels) {
		notes.push(
			"Imported at its authored orientation. FBX is Y-up like Unity, so the importer lines the two up " +
				"without the negative Y scale the OBJ path needs.",
		);
	} else if (options.flipUpAxis ?? true) {
		notes.push(
			"Imported with a negative Y scale so the objects sit sensibly in Blender's Z-up space. If you " +
				"export this back to Unity, expect the handedness to be restored by the importer, not doubled.",
		);
	}
	if (!(options.saveAfter ?? true)) {
		notes.push(
			"NOT SAVED: these objects exist only in the live Blender session. blender_scene_info reads " +
				"the .blend from disk in a background process, so it will NOT list them (or this " +
				`collection) until you save. The collection is "${imported.collectionName}" -- select it ` +
				"there to see or delete the import.",
		);
	}

	return {
		objPath: objExport?.objPath ?? null,
		mtlPath: objExport?.mtlPath ?? null,
		stagedPaths: useSourceModels ? stagedPaths : undefined,
		models: sourceExport?.models,
		unhandoffableObjects: sourceExport?.unhandoffableObjects,
		/** Objects that could not be exported because their name is shared. */
		ambiguousObjectNames: ambiguousNames.length > 0 ? ambiguousNames : undefined,
		/** True when the transfer used BOTH routes: source files plus an OBJ fallback. */
		usedBothRoutes: useSourceModels && objExport !== null,
		importedNames: imported.importedNames,
		importedFiles: imported.importedFiles,
		armatures: imported.armatures,
		materialNames: imported.materialNames,
		collectionName: imported.collectionName,
		vertexTotal: imported.vertexTotal,
		saved: options.saveAfter ?? true,
		unityScene: unity.activeScene,
		blenderBlendPath: blender.blendPath,
		notes,
	};
}

export function describeTransferScope(options: {
	direction: TransferDirection;
	objectNames?: string[];
	destination?: string;
}): string {
	const where =
		options.direction === "blender-to-unity"
			? `Unity ${options.destination ?? "Assets/PiImported"}`
			: "the open .blend";
	const what =
		options.objectNames && options.objectNames.length > 0
			? options.objectNames.join(", ")
			: "the current selection (or everything, if nothing is selected)";
	return `${what} -> ${where}`;
}

export { resolve as resolvePath };
