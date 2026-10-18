/**
 * pi-unity-blender -- the binder extension.
 *
 * This extension deliberately does NOT import pi-unity-vrchat or pi-blender.
 * The only thing the two applications have in common is the file-queue bridge
 * protocol (a request JSON appears in a directory, the application writes a
 * response JSON back). Depending on the other extensions' internals would mean
 * depending on their request shapes, their environment variables, and their
 * install layout -- all of which can change or disappear independently. So
 * binder/bridge.ts speaks the wire protocol directly and is the single client
 * for both bridges.
 *
 * Installing: this extension is standalone. It does not require
 * pi-unity-vrchat to be present, but the transfers it performs obviously do need
 * both applications to be running with their bridges loaded.
 */

import { extname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	describeBlenderInstanceOwnership,
	getBlenderBridgeDir,
	getBundledSkillsDir,
	getManagerPrompt,
	getStagingDir,
	getUnityBridgeDir,
} from "./config.js";
import { readBridgeLock, isBridgeAlive } from "./binder/bridge.js";
import { loadManagerCore } from "./manager-core.js";
import { detectBlender, detectUnity } from "./binder/editors.js";
import {
	checkTransferPreconditions,
	describeTransferScope,
	readBothSessions,
	transferBlenderToUnity,
	transferUnityToBlender,
	type TransferDirection,
	type TransferPreconditions,
} from "./binder/transfer.js";

/**
 * The shared manager core, or this extension's own copy of it.
 *
 * See manager-core.ts for the resolution order and the reason it is a runtime
 * lookup rather than an import: this extension must keep working when
 * pi-manager-core is not installed, which is the normal case for anyone who
 * only wants transfers.
 */
const core = loadManagerCore();

const TRANSFER_DIRECTIONS = ["blender-to-unity", "unity-to-blender"] as const;

/**
 * The agents this manager may spawn.
 *
 * The `allowedAgents:` line in agents/unity-blender-manager.md (line 65) minus
 * the manager itself, which is the one asking. That line is what pi offers the
 * session; this set is what the gate enforces, so the two must be edited
 * together — test/agent-rosters.mjs compares them and fails on drift.
 *
 * Both sides' agents are here because a transfer genuinely needs both: a
 * describer for the source, then a worker on whichever side is being edited. A
 * roster of one side's agents would refuse the half of the job this session
 * exists to do.
 */
const UNITY_BLENDER_MANAGER_ROSTER = new Set([
	// Unity side.
	"unity-worker",
	"unity-critic",
	"unity-diagnostician",
	"unity-finalizer",
	"unity-reference-describer",
	"vrchat-unity-avatar",
	"vrchat-unity-world",
	// Blender side.
	"blender-worker",
	"blender-script-runner",
	"blender-merger",
	"blender-critic",
	"blender-diagnostician",
	"blender-finalizer",
	"blender-camera-aligner",
	"blender-reference-describer",
	// Both sides at once.
	"unity-blender-reference-describer",
]);

function isTransferDirection(value: unknown): value is TransferDirection {
	return TRANSFER_DIRECTIONS.includes(value as TransferDirection);
}

function formatJsonResult(value: unknown): string {
	return JSON.stringify(value, undefined, 2);
}

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
 * and `edit` without ever having been asked for it. The same rule pi-blender
 * follows for /blender.
 *
 * The MECHANISM — engaged flag, gate flag, and the exemption for a subagent
 * inside a manager session — is the shared core's, because all three manager
 * extensions need it and each previously reimplemented the exemption by a
 * regex of its own. The POLICY — which tools are refused and what the refusal
 * says — is below, because that is genuinely this extension's: a Blender
 * refusal naming `blender-worker` and a Unity refusal naming `unity-worker`
 * cannot both live in a shared file without it naming applications it does not
 * know about.
 *
 * The child exemption is by STRUCTURE — being a child at all — rather than by
 * a named exception: there is no manager subagent left to name, which is the
 * whole point of the command-session design.
 */
const managerMode = core.createManagerMode({
	// The gate is deny-by-default, so this list is load-bearing: a tool absent
	// here is REFUSED, and only the refusals below can let one through. It
	// matches the `tools:` line in agents/unity-blender-manager.md (line 31),
	// which is what pi actually hands this session — see test/allowlists.mjs,
	// which fails if the two drift.
	allowedTools: [
		// Delegation, supervision, and the two halves of waiting: bg_wait
		// blocks on this session's own async runs, subagent_supervisor answers
		// a child that needs a decision. Both belong to pi-subagents.
		"subagent",
		"subagents_enable",
		"bg_wait",
		"subagent_supervisor",
		"contact_supervisor",
		// Context management, from the ambient billion-context plugin. A
		// manager is the one role whose transcript grows without bound, and a
		// transfer session is the longest of all: it reads both applications'
		// state for every module. It is also the only role that can afford to
		// lose detail, because everything it still needs is in `todo`.
		//
		// Named explicitly because the gate is deny-by-default. pi itself ships
		// no compression tool, so listing one the session does not have is
		// harmless; omitting one that IS present is how a 100k session re-reads
		// a build it already summarized.
		"compress",
		"decompress",
		"search_context",
		"acp_status",
		"acp_cache",
		// Planning and reading agent definitions to write a brief with.
		"todo",
		"read",
		"grep",
		"find",
		"ls",
		"ask_user_question",
		// The transfer itself, and the read-only inspection either side needs to
		// decide what to transfer. `unity_source_models` is included because
		// choosing between the source file and a re-exported OBJ is this
		// session's judgement, not a worker's.
		"unity_blender_status",
		"unity_blender_transfer",
		"unity_source_models",
		"unity_workspace_init",
		"unity_scene_info",
		"unity_session_context",
		"unity_bridge_status",
		"unity_bones",
		"unity_inspect",
		"unity_vrc",
		"unity_world",
		"unity_module_revert",
		"unity_log_critique",
		// A transfer session composes a composite prefab on the Unity side, and
		// the manager prompt says so. Leaving it out of this list does not just
		// narrow the session: the gate is deny-by-default, so the manager reads a
		// brief telling it to compose a composite and is refused the one call
		// that does it. Keep the two in step.
		"unity_prefab_info",
		"unity_compose_prefab",
		"blender_workspace_init",
		"blender_scene_info",
		"blender_add_reference",
		"blender_session_context",
		"blender_bridge_status",
		"blender_module_revert",
		"blender_log_critique",
	],
	// The roster's RULE is the core's; only the names are ours. This manager had
	// no roster at all, so it could spawn any agent in the session — including a
	// writer that walks straight past the write/edit refusal below. The two sides'
	// agents are both here because a transfer genuinely needs both: the describer
	// for the source, then a worker on whichever side is being edited.
	agentRoster: [...UNITY_BLENDER_MANAGER_ROSTER],
	onGateMessage: (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason:
					"Manager role: do not author files. Blender bpy belongs to a `blender-worker` subagent and Unity C# to a `unity-worker`; spawn one with a compact brief (goal, object or GameObject names, acceptance criteria, workspace + module name) and read only its returned report. This session IS the manager — you were not handed a job to relay, and the subagents you spawn are the ones that do the work. If the file is unrelated to a transfer — project files, a config, a script of your own — say so and ask the user to run /unity-blender-exit, which lifts this gate.",
			};
		}
		if (event.toolName === "read") {
			const path = typeof event.input.path === "string" ? event.input.path : "";
			if (IMAGE_READ_EXTENSIONS.has(extname(path).toLowerCase())) {
				return {
					block: true,
					reason:
						"Manager role: do not read images. Judging a render or comparing it to a reference is the critic subagent's job — spawn a fresh-context `blender-critic` or `unity-critic` and let it return a PASS/FAIL verdict with concrete visual issues; read the returned critique text instead. To hand a reference image on, register it with `blender_add_reference` (which takes the `caption` you must write instead of a look) and put that path and caption in the subagent brief. A base64 image also stays in this session's transcript and is resent on every later request, so one read here inflates every remaining turn of the build.",
				};
			}
		}
		return null;
	},
});

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
	"That status also carries the live session state of both sides -- `blenderSession` (saved .blend path,",
	"isDirty, active object, selection) and `unitySession` (project path, active scene, selection) -- so one",
	"call tells you what is open and what is selected. Do not reach for a separate session-context tool to",
	"learn it. `isDirty: true` means the .blend has unsaved changes: only SAVED geometry crosses, so save first.",
	"A side reported `{ ok: false, error }` is not answering, and the other side's state is still valid.",
	"Mesh geometry, UVs, material slots, and base texture images cross. Material *graphs* do not: Blender's",
	"node trees and Unity's shader graphs are flattened to the properties the exchange format can carry, so",
	"always verify materials on the receiving side.",
	"Prefer transferring a named selection over the whole scene; the whole-scene path exists for a first look,",
	"not for shipping a production asset.",
	"Blender -> Unity goes through FBX (both apps read it well, and Unity cannot resolve Blender-relative",
	"texture paths, so textures are embedded in the file). Unity -> Blender hands over the SOURCE MODEL FILE",
	"Unity itself imported (an .fbx under Assets/), copied verbatim into the staging directory and imported by",
	"Blender at its authored orientation: no re-export, so the rig, the material assignment and the animation",
	"survive, and no axis flip is needed (FBX is Y-up like Unity). OBJ + MTL is only the fallback for objects with",
	"no source file on disk -- Unity has no built-in mesh exporter at all, so the bridge writes OBJ by hand. Run",
	"`unity_source_models { mode: \"find\" }` first to see which files would travel and which objects cannot.",
	"Staging files live in the pi cache directory, never inside a project or a .blend directory, so a failed",
	"transfer does not leave debris in the user's work.",
	"After a Blender -> Unity import, the result is a prefab in the destination folder; it is not added to the",
	"open scene unless you say so. Read the returned scene name and prefab path before assuming placement.",
	"After a Unity -> Blender import, the result is gathered in one named collection so it can be selected,",
	"moved, or deleted as a unit. An FBX carries no sub-mesh selection, so a file-based transfer brings every",
	"sub-mesh in that file; the result names the extras instead of narrowing the scope silently. Names may also",
	"differ from Unity's: Blender names imported objects after the file's own nodes, so trust the counts.",
].join(" ");

// The real ExtensionAPI rather than a hand-rolled structural type. The
// structural version had to be written by hand and it lied: it declared
// `on` as `(event: string, handler: (...args: unknown[]) => unknown)`, so the
// tool_call and before_agent_start handlers below got `unknown` events and
// ctx, and the `ctx.ui.notify` call in /unity-blender-exit failed to typecheck
// because the invented command context had no `ui`. The dependency is already
// in devDependencies, and pi-blender imports it the same way.
/**
 * The unity_blender_* family, registered inert and declared to the model only
 * when this session shows it needs them: /unity-blender engage, or a first
 * call. See pi-manager-core's lazy-tools for the mechanism.
 */
const LAZY_UNITY_BLENDER_TOOL_NAMES = [
	"unity_blender_transfer",
	"unity_blender_status",
];

const lazyTools = core.createLazyToolGate({
	toolNames: LAZY_UNITY_BLENDER_TOOL_NAMES,
	isEngaged: () => managerMode.isEngaged(),
});

export default function unityBlender(pi: ExtensionAPI) {
	// The binder is opt-in, like pi-unity-vrchat. Injecting transfer guidance on
	// every turn of every session is noise in a conversation that may never
	// mention Blender or Unity, and it competes for attention with whatever the
	// user is actually doing. Mirrors pi-unity-vrchat's engaged flag.
	managerMode.install(pi);
	lazyTools.install(pi);
	pi.registerTool({
		defaultActive: false,
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
						"unity-to-blender only: mirror the Y axis on import, so Unity's Y-up geometry sits " +
						"sensibly in Blender's Z-up space. Baked into the mesh (vertices, normals and winding " +
						"together) rather than left as a negative object scale, which Blender does not carry " +
						"normals or winding through. Does NOT apply to source model files: FBX is Y-up like " +
						"Unity and needs no flip. Defaults to true.",
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
			managerMode.markUsed();
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
		defaultActive: false,
		name: "unity_blender_status",
		label: "Unity / Blender bridge status",
		description:
			"Report whether the Blender and Unity pi bridges are alive, what each side currently has " +
			"open (the saved .blend and its selection, the Unity project, active scene and selection), " +
			"where each editor binary was found (env override, flatpak, Hub directory, or PATH -- " +
			"neither is necessarily on PATH), which bridge is locked and for how long, which Blender " +
			"instance this session shares, and every precondition not yet met for a transfer. " +
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
			managerMode.markUsed();
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

			// The live session state, which is the part that was missing: bridges
			// being up says nothing about what is open inside them. Each side is
			// read independently, so a user with only Blender open still gets
			// their Blender state and Unity's absence does not blank it.
			const { blender: blenderSession, unity: unitySession } = await readBothSessions({
				blender: blenderBridgeAlive,
				unity: unityBridgeAlive,
			});

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
				// Who owns that Blender, and whether this process is the owner.
				// A second window is invisible in a path, and the question a
				// user actually has when they see one is "is it mine?" — the
				// instance id answers it by comparison. See the comment on
				// describeBlenderInstanceOwnership in config.ts.
				blenderInstance: describeBlenderInstanceOwnership(),
				blenderLock,
				unityLock,
				// What each side has open, or why it could not be read. Blender's
				// isDirty is called out in the guidance because only SAVED work
				// crosses: a dirty .blend would export stale geometry, and the
				// transfer result says so in `notes` rather than failing.
				blenderSession,
				unitySession,
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
	//
	// The registration, the argument handling and the deliverAs choice are the
	// shared core's, because all three manager extensions send the user's text
	// the same way and getting `steer` wrong is invisible until a task is
	// silently dropped mid-build. What stays here is the binder's own text: the
	// opening task, and the autocomplete examples.
	core.registerEngageCommand(pi, {
		name: "unity-blender",
		description: "Transfer meshes and materials between a live Blender session and a live Unity Editor.",
		// No usage notice: a bare /unity-blender is meaningful here, not a
		// mistake. It opens by asking for status, because a transfer cannot
		// start before anyone knows which application is actually reachable.
		onEngage: () => {
			managerMode.markEngaged();
			lazyTools.activate(pi);
		},
		engagedMessage: "Transfer engaged — this session is the manager of both applications.",
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
		fallbackTask:
			"/unity-blender I want to move geometry between Blender and Unity. Start by calling " +
			"unity_blender_status so we know which applications are actually reachable, then tell me " +
			"what you can do and what you need from me before transferring anything.",
	});

	// Publish the bundled skills. Without this hook the skills dir is invisible
	// to pi, so the skill would exist on disk and never load -- the same
	// unreachable-feature failure as the unregistered unity_capture_view tool.
	pi.on("resources_discover", () => ({ skillPaths: [getBundledSkillsDir()] }));

	// /unity-blender-exit lifts the manager gate without ending the session or
	// touching the tools. Without it a session that interleaves a transfer with
	// writing a file of its own stays restricted until /new.
	core.registerExitCommand(pi, {
		name: "unity-blender-exit",
		description: "Leave transfer manager mode — lift the write/edit/image gate (keeps the session and the tools)",
		onExit: () => managerMode.clearGate(),
		notEngagedMessage: "Not in transfer manager mode — nothing to exit.",
		exitedMessage:
			"Left transfer manager mode. The unity_blender_* tools, /unity-blender and the skills are still available; run /unity-blender to re-enter.",
	});

	// A new session is a fresh start: the binder goes back to silent until the
	// user runs /unity-blender or a unity_blender_* tool again, and so does the
	// gate — a session that ends must not leave the next one restricted. A
	// /reload is not a new session and keeps both; see createManagerMode's
	// reset().
	pi.on("session_start", (event) => {
		managerMode.reset(event?.reason);
		// Same reset semantics as the gate: a reload keeps an activated
		// family, a fresh session starts inert.
		lazyTools.reset(event?.reason);
	});

	// Manager-role enforcement: the parent session plans, delegates, and reads
	// reports. Blender code belongs to a `blender-worker` subagent, Unity C# to
	// a `unity-worker`, and judging how a render looks to a critic that has
	// vision. The gate itself is installed above, by the shared core; this
	// extension supplies the three refusals, because they name agents only this
	// manager can spawn.

	// Injection goes through the shared core, the same as the other two
	// managers, but with two differences that are real rather than incidental
	// and are therefore named as options:
	//
	//  - `staticContent`, because there is nothing to prefetch. This manager's
	//    live state arrives from ONE `unity_blender_status` call that reports
	//    both sides, and the guidance tells the manager to make exactly that
	//    call. Fetching a second time would spend a bridge round trip restating
	//    what a tool call is about to return anyway.
	//  - `sectionReachesChildren: false`, because unlike the other two this
	//    prompt is the connector's own instructions, not one side's procedure,
	//    and the workers here are spawned with agent definitions that already
	//    state which side they are on.
	pi.on(
		"before_agent_start",
		core.createContextInjection({
			section: "unity_blender_manager",
			customType: "unity_blender_context",
			shouldInject: () => managerMode.isEngaged(),
			getPrompt: getManagerPrompt,
			staticContent: unityBlenderGuidance,
			sectionReachesChildren: false,
		}),
	);
}
