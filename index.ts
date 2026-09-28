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

import { extname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/** The name pi-subagents stamps into every child session's system prompt. */
const CHILD_AGENT_PROMPT_PATTERN = /<active_agent\s+name="([^"]*)"/;

/**
 * Image types `read` would attach to the request, mirroring pi's own sniffing.
 *
 * Blocking these is the whole point of the manager gate: a base64 image payload
 * stays in the transcript and is resent on every subsequent request, so one
 * stray read of a reference photo inflates every later turn of a long session
 * and can make the provider reject the whole conversation.
 */
const IMAGE_READ_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * Manager mode, entered ONLY by the /unity-blender command.
 *
 * It must not be set by a tool call. Calling `unity_blender_status` to answer a
 * one-line question is not the user asking for a build, and turning the session
 * into a delegating manager on that basis would block the user's own `write`
 * and `edit` without ever having been asked for it. The same rule pi-vibe-blender
 * follows for /blender.
 */
let managerMode = false;
function markManagerMode(): void {
	managerMode = true;
}

/**
 * Leave manager mode, undoing /unity-blender's gate.
 *
 * Without this the gate would last until the session restarted, which breaks a
 * session that interleaves transfer work with writing a script, a C# file, or a
 * project file of any kind. Exiting is deliberately not a /new: only the
 * restriction on this session ends, the extensions and their tools stay loaded.
 */
function clearManagerMode(): boolean {
	if (!managerMode) return false;
	managerMode = false;
	return true;
}

/**
 * The binder's own root manager agent. It is a child, so the blanket exemption
 * below would otherwise cover it — and it must not be, for the same reason
 * pi-vibe-blender gates `blender-manager` by name: a spawned manager is a child
 * that must still DELEGATE, and letting it read a reference image or author a
 * file is exactly the drift the manager role exists to prevent.
 */
const BINDER_MANAGER_AGENT_NAME = "unity-blender-manager";

/**
 * Whether this session is acting as THE manager, and so is subject to the gate.
 *
 * A spawned child (blender-worker, unity-worker, a critic) is exempt even
 * though the flag is process-wide: those agents MUST author code and look at
 * renders, and they carry an `<active_agent name="...">` tag in their prompt.
 * Gating them would make the delegation this mode exists to cause impossible.
 * The one exception is a spawned MANAGER, which is a child that still has to
 * delegate rather than author, so it is named explicitly instead.
 */
function isManagerSession(systemPrompt: string): boolean {
	if (!managerMode) return false;
	const child = CHILD_AGENT_PROMPT_PATTERN.exec(systemPrompt)?.[1] ?? null;
	return child === null || child === BINDER_MANAGER_AGENT_NAME;
}

const MANAGER_ROLE_GUIDANCE = [
	"You are in transfer manager mode, entered by /unity-blender: you hold the user's goal, the task breakdown, and each subagent's brief and report.",
	"You do NOT author Blender bpy, Unity C#, or any other file yourself. An enforced gate blocks your `write`/`edit` and any `read` of an image (`.png`, `.jpg`, `.gif`, `.webp`, `.bmp`), so a direct approach is a dead end. Delegate to the subagents that do own that work: `blender-worker` authors and runs bpy in Blender, `blender-critic` judges how a render LOOKS, `blender-manager` can plan and run a whole Blender build end to end, and on the Unity side `unity-worker` authors and runs C# and `unity-critic` judges the scene. The `unity_*` and `blender_*` tools remain usable directly — they are for reading state, and the gate does not touch them.",
	"A reference image is a worker's and a critic's input, never yours. Register it with `blender_add_reference` (it copies the file into `<workspace>/references/` and requires a `caption`, because you cannot read the image yourself), then pass the registered path AND your caption into every affected subagent brief. Never open the image to describe it — the caption is the only channel, which is exactly why the tool demands one.",
	"Per critic, one render plus one reference image, never a third: image payloads persist in the transcript and are resent every request, so a few extra reads make the provider reject the entire conversation. `blender_scene_info`, `unity_scene_info` and `unity_blender_status` are text and cost nothing against that budget, so prefer them to a second look.",
	"The gate lifts at /unity-blender-exit or on the next session start. If the user asks for something plainly unrelated to a transfer that needs you to write or edit files, say once, in one sentence, that you are still in transfer manager mode and that /unity-blender-exit lifts it, then carry on with whatever transfer work is still open. Mention it at most once per session.",
	"Do not restate tool schemas in prose. Use the tool definitions directly.",
].join(" ");

/**
 * One sentence an agent can act on. Liveness leads, because that is what
 * actually stops a transfer; the per-direction checklist is secondary detail.
 */
function describeStatus(
	busy: boolean,
	deadBridges: string[],
	preconditions: TransferPreconditions | null,
	unreadableLocks: string[],
): string {
	if (busy) {
		if (unreadableLocks.length > 0) {
			return (
				`${unreadableLocks.join(" and ")} holds a lock file that could not be parsed, so a ` +
				"request is almost certainly still running -- possibly one that died mid-transfer. " +
				"Wait and re-check; the lock is reclaimed automatically once it passes the stale " +
				"threshold, and starting a second transfer now would only queue behind it."
			);
		}
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

// The real ExtensionAPI rather than a hand-rolled structural type. The
// structural version had to be written by hand and it lied: it declared
// `on` as `(event: string, handler: (...args: unknown[]) => unknown)`, so the
// tool_call and before_agent_start handlers below got `unknown` events and
// ctx, and the `ctx.ui.notify` call in /unity-blender-exit failed to typecheck
// because the invented command context had no `ui`. The dependency is already
// in devDependencies, and pi-vibe-blender imports it the same way.
export default function unityBlender(pi: ExtensionAPI) {
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
			const unreadableLocks = [
				...(blenderLock?.unreadable ? ["Blender"] : []),
				...(unityLock?.unreadable ? ["Unity"] : []),
			];
			// Liveness drives this sentence, not the per-direction checklist.
			// `preconditions` is null unless a direction was given, so keying off
			// its problems made the no-argument call report "both reachable" even
			// with a bridge down.
			const recommendation = describeStatus(
				blenderLock !== null || unityLock !== null,
				deadBridges,
				preconditions,
				unreadableLocks,
			);

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
							label: "Blender -> Unity",
							description: "Blender -> Unity, current selection",
						},
						{
							value: "export the selected GameObjects from Unity into the open .blend",
							label: "Unity -> Blender",
							description: "Unity -> Blender, current selection",
						},
					],
		async handler(args: string, ctx: { isIdle?: () => boolean }) {
			markEngaged();
			// Entering manager mode here, and ONLY here, is what makes the gate
			// below structural rather than advisory. A tool call must not do it:
			// checking status is not the user asking for a build.
			markManagerMode();
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

	// /unity-blender-exit lifts the manager gate without ending the session or
	// touching the tools. Without it a session that interleaves a transfer with
	// writing a file of its own stays restricted until /new.
	pi.registerCommand("unity-blender-exit", {
		description: "Leave transfer manager mode — lift the write/edit/image gate (keeps the session and the tools)",
		handler: async (_args, ctx) => {
			if (!clearManagerMode()) {
				ctx.ui.notify("Not in transfer manager mode — nothing to exit.", "info");
				return;
			}
			ctx.ui.notify(
				"Left transfer manager mode. The unity_blender_* tools, /unity-blender and the skills are still available; run /unity-blender to re-enter.",
				"info",
			);
		},
	});

	// A new session is a fresh start: the binder goes back to silent until the
	// user runs /unity-blender or a unity_blender_* tool again, and so does the
	// gate — a session that ends must not leave the next one restricted.
	pi.on("session_start", () => {
		binderEngaged = false;
		managerMode = false;
	});

	// Manager-role enforcement: the parent session plans, delegates, and reads
	// reports. Blender code belongs to a `blender-worker` subagent, Unity C# to
	// a `unity-worker`, and judging how a render looks to a critic that has
	// vision. This gate makes that structural instead of advisory, because
	// without it the parent drifts into doing everything itself and pays for
	// every render and every script in its own context.
	//
	// Blocked in the manager: every `write`/`edit`, and `read` of an image.
	// Allowed: text reads including `*.md` (the skills and agent definitions are
	// needed to write the briefs), `bash`, and every `unity_*` / `blender_*`
	// tool, which are custom tools and pass through untouched.
	//
	// Gated on managerMode, not on a transfer tool having run: the manager role
	// exists only after /unity-blender. A session that calls a tool directly is
	// doing the work itself, and blocking its writes would be backwards.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			if (!isManagerSession(ctx.getSystemPrompt())) return undefined;
			return {
				block: true,
				reason:
					"Manager role: do not author files. Blender bpy belongs to a `blender-worker` subagent and Unity C# to a `unity-worker`; spawn one with a compact brief (goal, object or GameObject names, acceptance criteria, workspace + module name) and read only its returned report. If you need to plan a whole build rather than drive one tool at a time, spawn `blender-manager` or `unity-manager` and let them run it end to end. If the file is unrelated to a transfer — project files, a config, a script of your own — say so and ask the user to run /unity-blender-exit, which lifts this gate.",
			};
		}

		if (event.toolName === "read") {
			if (!isManagerSession(ctx.getSystemPrompt())) return undefined;
			const path = typeof event.input.path === "string" ? event.input.path : "";
			if (IMAGE_READ_EXTENSIONS.has(extname(path).toLowerCase())) {
				return {
					block: true,
					reason:
						"Manager role: do not read images. Judging a render or comparing it to a reference is the critic subagent's job — spawn a fresh-context `blender-critic` or `unity-critic` and let it return a PASS/FAIL verdict with concrete visual issues; read the returned critique text instead. To hand a reference image on, register it with `blender_add_reference` (which takes the `caption` you must write instead of a look) and put that path and caption in the subagent brief. A base64 image also stays in this session's transcript and is resent on every later request, so one read here inflates every remaining turn of the build.",
				};
			}
		}

		return undefined;
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

	// The manager-role rules go into a system-prompt section, not a per-turn
	// message: they are constant, and pi diffs system sections per run, so on
	// steady-state turns this costs nothing and never lands after the user's
	// prompt the way an appended message would.
	pi.on("before_agent_start", (event, ctx) => {
		if (!isManagerSession(ctx.getSystemPrompt())) return undefined;
		// The mutable sections live on the EVENT. Reaching for
		// ctx.systemPromptOptions is the first thing that looks plausible and
		// does not exist on ExtensionContext.
		event.systemPromptOptions.sections.unity_blender_manager = MANAGER_ROLE_GUIDANCE;
		return undefined;
	});
}
