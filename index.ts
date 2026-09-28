/**
 * pi-unity-blender -- the binder extension.
 *
 * This extension deliberately does NOT import pi-vibe-unity or pi-vibe-blender.
 * The only thing the two applications have in common is the file-queue bridge
 * protocol (a request JSON appears in a directory, the application writes a
 * response JSON back). Depending on the other extensions' internals would mean
 * depending on their request shapes, their environment variables, and their
 * install layout -- all of which can change or disappear independently. So
 * binder/bridge.ts speaks the wire protocol directly and is the single client
 * for both bridges.
 *
 * Installing: this extension is standalone. It does not require
 * pi-vibe-unity to be present, but the transfers it performs obviously do need
 * both applications to be running with their bridges loaded.
 */

import { Type } from "typebox";

import {
	getBlenderBridgeDir,
	getBundledSkillsDir,
	getStagingDir,
	getUnityBridgeDir,
} from "./config.js";
import { readBridgeLock, isBridgeAlive } from "./binder/bridge.js";
import { detectBlender, detectUnity } from "./binder/editors.js";
import {
	checkTransferPreconditions,
	describeTransferScope,
	transferBlenderToUnity,
	transferUnityToBlender,
	type TransferDirection,
	type TransferPreconditions,
} from "./binder/transfer.js";

const TRANSFER_DIRECTIONS = ["blender-to-unity", "unity-to-blender"] as const;

function isTransferDirection(value: unknown): value is TransferDirection {
	return TRANSFER_DIRECTIONS.includes(value as TransferDirection);
}

function formatJsonResult(value: unknown): string {
	return JSON.stringify(value, undefined, 2);
}

/**
 * One sentence an agent can act on. Liveness leads, because that is what
 * actually stops a transfer; the per-direction checklist is secondary detail.
 */
function describeStatus(
	busy: boolean,
	deadBridges: string[],
	preconditions: TransferPreconditions | null,
): string {
	if (busy) {
		return (
			"Another transfer or bridge request is running. Wait for it to finish; both bridges " +
			"serialize requests and concurrent ones interleave in one shared session."
		);
	}
	if (deadBridges.length > 0) {
		const both = deadBridges.length > 1;
		return (
			`${deadBridges.join(" and ")} ${both ? "are" : "is"} not answering. A transfer needs ` +
			`${both ? "both sides" : "that side"} open with the pi bridge loaded; starting one now ` +
			`would fail after a long timeout rather than immediately.`
		);
	}
	if (preconditions !== null && preconditions.problems.length > 0) {
		return "Both bridges are reachable, but read the notes above before transferring.";
	}
	return "Both bridges are reachable and idle.";
}

const unityBlenderGuidance = [
	"pi-unity-blender moves meshes and materials between a live Blender session and a live Unity Editor.",
	"Both applications must already be open with their pi bridges loaded: check `unity_blender_status` first,",
	"and it reports exactly which side is missing rather than failing halfway through a transfer.",
	"Mesh geometry, UVs, material slots, and base texture images cross. Material *graphs* do not: Blender's",
	"node trees and Unity's shader graphs are flattened to the properties the exchange format can carry, so",
	"always verify materials on the receiving side.",
	"Prefer transferring a named selection over the whole scene; the whole-scene path exists for a first look,",
	"not for shipping a production asset.",
	"Blender -> Unity goes through FBX (both apps read it well, and Unity cannot resolve Blender-relative",
	"texture paths, so textures are embedded in the file). Unity -> Blender goes through OBJ + MTL, because",
	"Blender's OBJ importer is native while Unity has no built-in mesh exporter at all.",
	"Staging files live in the pi cache directory, never inside a project or a .blend directory, so a failed",
	"transfer does not leave debris in the user's work.",
	"After a Blender -> Unity import, the result is a prefab in the destination folder; it is not added to the",
	"open scene unless you say so. Read the returned scene name and prefab path before assuming placement.",
	"After a Unity -> Blender import, the result is gathered in one named collection so it can be selected,",
	"moved, or deleted as a unit; the Y axis is flipped by default because Unity is Y-up and Blender is Z-up.",
].join(" ");

export default function unityBlender(pi: {
	registerTool: (tool: unknown) => void;
	// Two-argument form, matching ExtensionAPI: registerCommand(name, options).
	// The name is the first parameter because pi keys the command by it.
	registerCommand: (
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (argumentPrefix: string) => unknown;
			handler: (args: string, ctx: { isIdle?: () => boolean }) => Promise<void> | void;
		},
	) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	sendUserMessage: (text: string, options?: { deliverAs?: string }) => void;
}) {
	// The binder is opt-in, like pi-vibe-unity. Injecting transfer guidance on
	// every turn of every session is noise in a conversation that may never
	// mention Blender or Unity, and it competes for attention with whatever the
	// user is actually doing. Mirrors pi-vibe-unity's `unityEngaged` flag.
	let binderEngaged = false;
	const markEngaged = (): void => {
		binderEngaged = true;
	};
	pi.registerTool({
		name: "unity_blender_transfer",
		label: "Unity / Blender transfer",
		description:
			"Transfer meshes and materials between a live Blender session and a live Unity Editor. " +
			"Blender -> Unity exports FBX from Blender and imports it as a prefab in the Unity project; " +
			"Unity -> Blender hands over the SOURCE model file Unity itself imported (an .fbx under " +
			"Assets/), falling back to OBJ for meshes with no source file, and imports it into the open " +
			".blend as a named collection. Prefer the source file: it carries the rig and material " +
			"description, which OBJ cannot express. An FBX carries no sub-mesh selection, so the whole " +
			"file comes across and the result names the extra parts. " +
			"Both applications must already be running with their pi bridges loaded -- call unity_blender_status first. " +
			"Material graphs are flattened to the exchange format; verify materials on the receiving side.",
		parameters: Type.Object({
			direction: Type.Union(
				[
					Type.Literal("blender-to-unity"),
					Type.Literal("unity-to-blender"),
				],
				{
					description:
						"Which way the geometry moves. 'blender-to-unity' exports from the open .blend into the open " +
						"Unity project. 'unity-to-blender' exports from the active Unity scene into the open .blend.",
				},
			),
			objectNames: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Blender object names (for blender-to-unity) or Unity GameObject names (for unity-to-blender) " +
						"to limit the transfer to. Omit to use the current selection in the source application; when " +
						"nothing is selected there, every mesh/root object is exported and the result says so.",
				}),
			),
			destination: Type.Optional(
				Type.String({
					description:
						"blender-to-unity only: folder inside Assets/ to import into, e.g. \"Assets/Art/Vehicles\". " +
						"Ignored for the other direction.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"blender-to-unity only: name for the resulting prefab. Defaults to the .fbx file name. Ignored for the other direction.",
				}),
			),
			collectionName: Type.Optional(
				Type.String({
					description:
						"unity-to-blender only: name of the Blender collection to gather the import under. " +
						"Defaults to \"Pi_Imported\". Ignored for the other direction.",
				}),
			),
			flipUpAxis: Type.Optional(
				Type.Boolean({
					description:
						"unity-to-blender only: apply a negative Y scale on import so Unity's Y-up geometry sits " +
						"sensibly in Blender's Z-up space. Defaults to true.",
				}),
			),
			preferSourceModels: Type.Optional(
				Type.Boolean({
					description:
						"unity-to-blender only: default true. Hand over the source model file Unity imported " +
						"instead of re-exporting OBJ. Set false to force OBJ -- the only option for meshes with " +
						"no source file, and an escape hatch when a specific FBX misbehaves. Ignored for the " +
						"other direction.",
				}),
			),
			saveAfter: Type.Optional(
				Type.Boolean({
					description:
						"Save the .blend after the transfer. Defaults to true. Set false to keep the change " +
						"reversible in the Editor's undo stack.",
				}),
			),
		}),
		// pi calls execute(toolCallId, params, signal, onUpdate, ctx). Taking
		// (args, signal) silently binds the toolCallId STRING as args, so every
		// field reads as undefined -- which surfaced as
		// "Unknown transfer direction undefined" for a call that plainly
		// passed one. tsc cannot catch this: the shape is a local type assertion.
		async execute(
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: unknown,
		) {
			markEngaged();
			const options = (params ?? {}) as {
				direction: TransferDirection;
				objectNames?: string[];
				destination?: string;
				name?: string;
				collectionName?: string;
				flipUpAxis?: boolean;
				saveAfter?: boolean;
				preferSourceModels?: boolean;
			};

			// The direction arrives from a model, so validate it explicitly rather
			// than letting a typo fall through to the other leg.
			if (!isTransferDirection(options.direction)) {
				throw new Error(
					`Unknown transfer direction ${JSON.stringify(options.direction)}. Use ` +
						`${TRANSFER_DIRECTIONS.join(" or ")}.`,
				);
			}

			// A misspelled key is otherwise dropped silently, and the transfer then
			// falls back to "everything" -- which is the most destructive default
			// here. Cost of this check: three lines. Cost of skipping it: a call
			// meant for one object silently moves every object.
			const KNOWN_KEYS = [
				"direction",
				"objectNames",
				"destination",
				"name",
				"collectionName",
				"flipUpAxis",
				"saveAfter",
				"preferSourceModels",
			];
			const unknownKeys = Object.keys(options as Record<string, unknown>).filter(
				(key) => !KNOWN_KEYS.includes(key),
			);
			if (unknownKeys.length > 0) {
				throw new Error(
					`Unknown parameter(s): ${unknownKeys.map((key) => `"${key}"`).join(", ")}. ` +
						`Valid parameters are: ${KNOWN_KEYS.join(", ")}. ` +
						`Note that objects are selected with "objectNames" for BOTH directions -- ` +
						`"gameObjectNames" is not a parameter. A misspelled key is rejected rather than ` +
						`ignored, because ignoring it falls back to transferring the whole scene.`,
				);
			}

			const preconditions = await checkTransferPreconditions(options.direction);
			// Hard failures only: a missing CLI binary is a note, because both
			// legs run inside an already-open application.
			const hardProblems = preconditions.problems.filter(
				(problem) => !problem.startsWith("Note:"),
			);
			if (hardProblems.length > 0) {
				throw new Error(
					`The transfer cannot start yet:\n- ${hardProblems.join("\n- ")}\n` +
						`Run unity_blender_status for the full picture.`,
				);
			}

			if (signal?.aborted) {
				throw new Error("The transfer was aborted before it started.");
			}
			const result =
				options.direction === "blender-to-unity"
					? await transferBlenderToUnity({
							objectNames: options.objectNames,
							destination: options.destination,
							name: options.name,
							saveAfter: options.saveAfter,
						})
					: await transferUnityToBlender({
							gameObjectNames: options.objectNames,
							collectionName: options.collectionName,
							flipUpAxis: options.flipUpAxis,
							saveAfter: options.saveAfter,
							preferSourceModels: options.preferSourceModels,
						});
			const scope = describeTransferScope({
				direction: options.direction,
				objectNames: options.objectNames,
				destination: options.destination,
			});

			return {
				content: [
					{
						type: "text",
						text: `Transferred: ${scope}\n\n${formatJsonResult(result)}`,
					},
				],
				details: { ...result, scope },
			};
		},
	});

	pi.registerTool({
		name: "unity_blender_status",
		label: "Unity / Blender bridge status",
		description:
			"Report whether the Blender and Unity pi bridges are alive, where each editor binary was " +
			"found (env override, flatpak, Hub directory, or PATH -- neither is necessarily on PATH), " +
			"which bridge is locked and for how long, and every precondition not yet met for a transfer. " +
			"Call this before a transfer instead of discovering a missing Editor after a long cold start.",
		parameters: Type.Object({
			direction: Type.Optional(
				Type.Union([Type.Literal("blender-to-unity"), Type.Literal("unity-to-blender")], {
					description:
						"Optional: check preconditions for this specific direction. Omit to report the general state.",
				}),
			),
		}),
		// Same signature bug as the transfer tool: the second parameter is the
		// params object, not the toolCallId. This one read as "works" only
		// because it ignores most of its input -- it silently never saw a
		// `direction`, so `preconditions` was always null.
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: unknown,
		) {
			markEngaged();
			const direction = (params as { direction?: TransferDirection } | undefined)?.direction;
			// Always compute the liveness and detection facts. Only the
			// per-direction precondition checklist is optional -- defaulting
			// liveness to `false` when `direction` is omitted would report both
			// bridges dead while they are happily running.
			const preconditions = direction
				? await checkTransferPreconditions(direction)
				: null;
			const blenderBridgeAlive = isBridgeAlive(getBlenderBridgeDir());
			const unityBridgeAlive = isBridgeAlive(getUnityBridgeDir());
			const [blender, unity] = await Promise.all([detectBlender(), detectUnity()]);
			const blenderLock = readBridgeLock(getBlenderBridgeDir());
			const unityLock = readBridgeLock(getUnityBridgeDir());

			const deadBridges = [
				...(blenderBridgeAlive ? [] : ["Blender"]),
				...(unityBridgeAlive ? [] : ["Unity"]),
			];
			// Liveness drives this sentence, not the per-direction checklist.
			// `preconditions` is null unless a direction was given, so keying off
			// its problems made the no-argument call report "both reachable" even
			// with a bridge down.
			const recommendation = describeStatus(blenderLock !== null || unityLock !== null, deadBridges, preconditions);

			const result = {
				blenderBridgeAlive,
				unityBridgeAlive,
				blender,
				unity,
				blenderBridgeDir: getBlenderBridgeDir(),
				unityBridgeDir: getUnityBridgeDir(),
				stagingDir: getStagingDir(),
				blenderLock,
				unityLock,
				busy: blenderLock !== null || unityLock !== null,
				preconditions,
				recommendation,
			};

			return {
				content: [{ type: "text", text: formatJsonResult(result) }],
				details: result,
			};
		},
	});

	// Two-argument form: registerCommand(name, options). The object form does
	// not exist -- pi keys the command by the first parameter, so passing a
	// spec object registers it under `undefined` and the slash command is
	// unreachable. See RegisteredCommand in pi's dist/core/extensions/types.d.ts.
	// There is also no `getArgument` option; `description` and
	// `getArgumentCompletions` are the documented affordances.
	pi.registerCommand("unity-blender", {
		description: "Transfer meshes and materials between a live Blender session and a live Unity Editor.",
		getArgumentCompletions: (argumentPrefix: string) =>
			argumentPrefix.length > 0
				? null
				: [
						{
							value: "move the selected meshes from Blender into Assets/Art",
							description: "Blender -> Unity, current selection",
						},
						{
							value: "export the selected GameObjects from Unity into the open .blend",
							description: "Unity -> Blender, current selection",
						},
					],
		async handler(args: string, ctx: { isIdle?: () => boolean }) {
			markEngaged();
			const task =
				args.trim().length > 0
					? `/unity-blender ${args.trim()}`
					: "/unity-blender I want to move geometry between Blender and Unity. Start by calling " +
						"unity_blender_status so we know which applications are actually reachable, then tell me " +
						"what you can do and what you need from me before transferring anything.";
			pi.sendUserMessage(task, {
				deliverAs: ctx.isIdle?.() ? undefined : "steer",
			});
		},
	});

	// Publish the bundled skills. Without this hook the skills dir is invisible
	// to pi, so the skill would exist on disk and never load -- the same
	// unreachable-feature failure as the unregistered unity_capture_view tool.
	pi.on("resources_discover", () => ({ skillPaths: [getBundledSkillsDir()] }));

	// A new session is a fresh start: the binder goes back to silent until the
	// user runs /unity-blender or a unity_blender_* tool again.
	pi.on("session_start", () => {
		binderEngaged = false;
	});

	pi.on("before_agent_start", () => {
		if (!binderEngaged) return undefined;
		return {
			message: {
				customType: "unity_blender_context",
				content: unityBlenderGuidance,
				display: true,
			},
		};
	});
}
