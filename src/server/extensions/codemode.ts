/**
 * Codemode lets the agent write JavaScript that calls its other tools, to batch independent calls, chain them, or
 * filter large output before it reaches the model. Scripts run in a QuickJS sandbox without Node, files, network, or
 * timers; their only capability is calling tools. Every call a script makes goes through the same steps as a direct
 * call (argument checks, then every `beforeTool` and `afterTool` hook), so Lancet Guard judges each one and can ask
 * for approval. Only the script's output reaches the model. `store()` values are kept per conversation.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
    type CodemodeResult,
    CodemodeSandbox,
    parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import {
    defineExtension,
    defineTool,
    type JsonObject,
    LiveDoc,
    section,
    type ToolExecutionApi,
    type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "../docs.ts";
import { describe } from "../errors.ts";
import type { PocketHost } from "../host.ts";

export const CODEMODE_TOOL = "codemode";
/** Output budget of a script, in estimated tokens (4 characters each), unless its options line sets another. */
const MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
/** What a script gets of one nested call's text: enough to filter, not enough to exhaust the VM. */
const MAX_NESTED_CHARS = 1_000_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

const DESCRIPTION = `Run JavaScript that calls your other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` takes the same arguments as calling the tool directly, resolves to its structured output (text for ordinary tools), and rejects with an Error when the call fails or is blocked. Calls still running when the script ends are cancelled and joined before this call settles.
- Each call is checked like a direct call: Lancet Guard may block it or wait for a person to approve it.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`
Globals:
- \`text(value)\`, \`image(dataUrlOrImageBlock)\`, \`console.log(...)\`, and top-level \`return\` add output; \`exit()\` ends the script.
- \`store(key, value)\` and \`load(key)\` keep JSON values across codemode calls in this conversation.
- \`ALL_TOOLS\` lists the tools a script can call.`;

/** One call a script made. `path`: the file it worked on, when it names one; Changes looks for writes. */
type CallRecord = {
    name: string;
    status: "running" | "ok" | "error" | "cancelled";
    path?: string;
    durationMs?: number;
    error?: string;
};
type CodemodeDetails = { calls: CallRecord[]; fullOutputPath?: string };

function bound(text: string, retain: "head" | "tail"): string {
    if (text.length <= MAX_NESTED_CHARS) {
        return text;
    }

    const note = `[${text.length - MAX_NESTED_CHARS} characters not shown]`;

    return retain === "tail"
        ? `${note}\n${text.slice(-MAX_NESTED_CHARS)}`
        : `${text.slice(0, MAX_NESTED_CHARS)}\n${note}`;
}

/** Like the script's `text()`: strings as they are, anything else as JSON. */
function valueText(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function formatError(
    result: Extract<CodemodeResult, { ok: false }>,
    calls: readonly CallRecord[],
): string {
    const { error } = result;
    const head =
        error.kind === "script"
            ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
            : error.kind === "timeout"
              ? `Script timed out: ${error.message}`
              : error.kind === "aborted"
                ? `Script aborted: ${error.message}`
                : `Script sandbox failed: ${error.message}`;
    const summary =
        calls.length === 0
            ? "No tool calls were made."
            : `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;

    return `${head}\n\n${summary}`;
}

type OutputItem =
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Keep the start and end of text over the budget; the whole text goes to a temporary file the agent can read. */
async function budget(
    items: OutputItem[],
    maxTokens: number,
): Promise<{ items: OutputItem[]; fullOutputPath?: string }> {
    const texts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
    const combined = texts.join("\n");
    const limit = maxTokens * CHARS_PER_TOKEN;

    if (combined.length <= limit) {
        return { items };
    }

    const head = combined.slice(0, Math.floor(limit / 2));
    const tail = combined.slice(-(limit - head.length));
    let text = `Warning: output truncated (about ${Math.ceil(combined.length / CHARS_PER_TOKEN)} tokens, ${combined.split("\n").length} lines)\n\n${head}\n… ${Math.ceil((combined.length - limit) / CHARS_PER_TOKEN)} tokens not shown …\n${tail}`;
    const path = join(tmpdir(), `pi-pocket-codemode-${randomBytes(8).toString("hex")}.txt`);

    try {
        await writeFile(path, combined, { mode: 0o600 });
        text += `\n\n[Full output: ${path} (read it with offset and limit)]`;
    } catch (error) {
        text += `\n\n[Could not save the full output: ${describe(error)}]`;

        return {
            items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
        };
    }

    return {
        items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
        fullOutputPath: path,
    };
}

export default function createCodemode(_host: PocketHost) {
    const codemode = defineTool({
        name: CODEMODE_TOOL,
        description: DESCRIPTION,
        parameters: Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) }),
        // Scripts cannot start other scripts, including through the native nested-call API.
        callers: ["model"],
        // A script's nested calls (bash, writes) are not safe to run twice.
        replay: "unsafe",
        execute: async (args, api: ToolExecutionApi<CodemodeDetails>, context) => {
            const started = performance.now();
            const { code, options } = parseCodemodeSource(args.code);
            const agent = await api.agent(context);
            const callable = agent.callable.filter(
                (tool) => tool.name !== CODEMODE_TOOL,
            ) as ToolRegistration[];
            const calls: CallRecord[] = [];
            const publish = () =>
                void api
                    .details({ calls: calls.map((call) => ({ ...call })) }, context)
                    .catch(() => {});
            const pending = new Set<Promise<unknown>>();
            const workerExits: Promise<void>[] = [];
            let stopping = false;

            /** Native children own validation, hooks, memos, output limits and replay policy. */
            const nested = async (
                tool: ToolRegistration,
                input: unknown,
                signal: AbortSignal,
            ): Promise<unknown> => {
                const record: CallRecord = { name: tool.name, status: "running" };

                calls.push(record);
                publish();
                const callStarted = performance.now();
                const scope = withAbortSignal(signal, context);

                try {
                    signal.throwIfAborted();
                    const result = await api.executeTool(
                        tool.name,
                        (input ?? {}) as JsonObject,
                        scope,
                    );

                    signal.throwIfAborted();
                    // Native input preserves the request; the slot retains the accepted arguments
                    // after preparation and hooks until this parent settles.
                    const live = await api.snapshot(LiveDoc, api.conversationId, scope);
                    const path = live?.nestedTools?.find((slot) => slot.taskId === result.taskId)
                        ?.arguments.path;

                    if (typeof path === "string") {
                        record.path = path;
                    }

                    if (result.isError) {
                        const diagnostics = result.diagnostics.map((item) => item.message);
                        const value = result.structuredOutput;

                        throw new Error(
                            [
                                ...(value === undefined ? [] : [valueText(value)]),
                                ...diagnostics,
                            ].join("\n") || `Tool ${tool.name} failed`,
                        );
                    }

                    record.status = "ok";

                    return typeof result.structuredOutput === "string"
                        ? bound(result.structuredOutput, tool.outputLimits?.retain ?? "head")
                        : result.structuredOutput;
                } catch (error) {
                    record.status = signal.aborted ? "cancelled" : "error";
                    record.error = describe(error).slice(0, 500);

                    throw error;
                } finally {
                    record.durationMs = Math.round(performance.now() - callStarted);
                    publish();
                }
            };

            const sandbox = new CodemodeSandbox({
                tools: callable.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.parameters as Record<string, unknown>,
                    outputSchema: tool.structuredOutputSchema as
                        Record<string, unknown> | undefined,
                    execute: (input, { signal }) => {
                        const execution = nested(tool, input, signal);

                        pending.add(execution);
                        void execution.then(
                            () => pending.delete(execution),
                            () => pending.delete(execution),
                        );

                        return execution;
                    },
                })),
                timeoutMs: options.timeoutMs ?? Number.POSITIVE_INFINITY,
                memoryLimitBytes: MEMORY_LIMIT_BYTES,
                // Wasm loading can outlast a result cancelled during startup. Do not admit a
                // late worker after cleanup has already captured the workers it must join.
                acquireWorker: () => {
                    if (stopping) {
                        throw new Error("Codemode execution is stopping");
                    }

                    return () => {};
                },
                onWorkerStarted: (exited) => workerExits.push(exited),
            });
            const stored =
                (await api.snapshot(CodemodeStoreDoc, api.conversationId, context))?.values ?? {};
            let result: CodemodeResult;

            try {
                result = await sandbox.execute(code, {
                    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
                    store: stored,
                });
            } finally {
                stopping = true;

                try {
                    await sandbox.close();
                } finally {
                    // Join the VM and native-call waiters here. Cancelling those waits does not
                    // cancel their tasks: ToolTask settlement aborts and joins owned children
                    // before this parent becomes terminal or releases its writer reservation.
                    await Promise.allSettled([...workerExits, ...pending]);
                }
            }

            const items: OutputItem[] = result.output.map((item) =>
                item.type === "text" ? { type: "text", text: item.text } : item,
            );

            if (result.ok) {
                const { set, delete: removed } = result.storeWrites;

                if (Object.keys(set).length > 0 || removed.length > 0) {
                    await api.commit(async (tx) => {
                        const doc = await tx.doc(CodemodeStoreDoc, api.conversationId);

                        for (const key of removed) {
                            delete doc.values[key];
                        }

                        for (const [key, value] of Object.entries(set)) {
                            doc.values[key] = value as JsonValue;
                        }
                    }, context);
                }

                if (result.value !== undefined) {
                    items.push({ type: "text", text: valueText(result.value) });
                }
            } else {
                items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
            }

            const shown = await budget(items, options.maxOutputTokens ?? MAX_OUTPUT_TOKENS);
            const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${((performance.now() - started) / 1000).toFixed(1)} seconds\nOutput:\n`;

            return {
                output: [{ type: "text", text: header }, ...shown.items],
                details: {
                    calls,
                    ...(shown.fullOutputPath === undefined
                        ? {}
                        : { fullOutputPath: shown.fullOutputPath }),
                },
                ...(result.ok ? {} : { isError: true }),
            };
        },
    });

    return defineExtension({
        name: "pocket-codemode",
        tools: [codemode],
        sections: [
            section("codemode", ({ agent }) => {
                const names = agent.callable
                    .map((tool) => tool.name)
                    .filter((name) => name !== CODEMODE_TOOL);

                if (
                    !agent.tools.some((tool) => tool.name === CODEMODE_TOOL) ||
                    names.length === 0
                ) {
                    return undefined;
                }

                return `Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of making many separate calls. Scripts can call: ${names.join(", ")}.`;
            }),
        ],
    });
}
