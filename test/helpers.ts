// What the server tests share: an isolated Pi install and data folder, a scripted model, and small helpers. Import
// this before anything from src/: it points Pi's config at a temporary folder first.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import type { User } from "../src/server/config.ts";
import type { Client } from "../src/server/room.ts";
import type { HandoffResult } from "../src/server/work-items.ts";
import type { Relationship } from "../src/server/workflow-docs.ts";

export const context = BACKGROUND_CONTEXT;

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);
/** The home folder the app finds `~/.agents/skills` in, for the same isolation. */
export const home = join(root, "home");
mkdirSync(home);

const { PocketApp } = await import("../src/server/app.ts");
const { HandoffsDoc } = await import("../src/server/workflow-docs.ts");

export type App = Awaited<ReturnType<typeof PocketApp.open>>;

/** The text of the newest message a model request carries, and who sent it. */
export function lastText(context: { messages: readonly { role: string; content: unknown }[] }): {
    role: string;
    text: string;
} {
    const last = context.messages.findLast((message) => message.role !== "system")!;
    const content =
        typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : (last.content as { type: string; text?: string }[]);

    return {
        role: last.role,
        text: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join(""),
    };
}

/** Echoes the last message: enough for tests that do not care what Pi says. */
export const echo: FauxResponseStep = (context) =>
    fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);

const handoffScripts = new Map<string, ReturnType<typeof fauxToolCall>>();
const stripAuthor = (text: string) => text.replace(/^\[from:[^\]]+\]\s*/, "");

/** A scripted provider, "faux", that answers every request with `route`. */
export function scriptedModel(route: FauxResponseStep = echo) {
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "faux-1" },
            { id: "faux-2" },
            { id: "faux-vision", input: ["text", "image"] },
        ],
    });

    // Setup handoffs still cross Commands.submit and the real registered tool. Only model decisions
    // are scripted; the production authority, admission, creation and receipt paths stay intact.
    const wrapped: FauxResponseStep = (input, options, state, model) => {
        const user = input.messages.findLast((message) => message.role === "user");
        const script =
            user === undefined
                ? undefined
                : handoffScripts.get(stripAuthor(lastText({ messages: [user] }).text));

        if (script !== undefined) {
            const last = lastText(input);

            if (last.role === "user") {
                return fauxAssistantMessage([script], { stopReason: "toolUse" });
            }
        }

        return typeof route === "function" ? route(input, options, state, model) : route;
    };

    // Plenty: a test file of many subagents (each of whose turns takes one) used 200 up.
    faux.setResponses(Array.from({ length: 1000 }, () => wrapped));

    return faux;
}

/** Open the app on `dataDir` with the scripted model. Opening the same folder again is a restart; `now` moves its clock. */
export function openApp(
    model: ReturnType<typeof scriptedModel>,
    dataDir = join(root, "data"),
    now?: () => number,
): Promise<App> {
    return PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        home,
        ...(now === undefined ? {} : { now }),
    });
}

/** Wait until `check` holds, polling. */
export async function until(
    check: () => Promise<boolean> | boolean,
    what: string,
    timeoutMs = 10_000,
): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** Record `dollars` more of model usage in a conversation, the way a model response does: the scripted model costs nothing. */
export async function recordCost(app: App, id: ConversationId, dollars: number): Promise<void> {
    await app.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, id);

        usage.models["faux/faux-1"] ??= {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        usage.models["faux/faux-1"].cost.output += dollars;
        usage.models["faux/faux-1"].cost.total += dollars;
    }, context);
}

export const owner = (app: App) => app.config.users.find((user) => user.role === "owner")!;

/** A session in `cwd` with the scripted model, no thinking. */
export async function newSession(
    app: App,
    cwd = work,
    threadType?: string,
): Promise<ConversationId> {
    // New sessions start with a model someone picked, and none when nobody did: as if the owner picked this one before.
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), {
        cwd,
        ...(threadType === undefined ? {} : { threadType }),
    });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

/** Send a message as the owner and wait for Pi's answer. */
export async function say(
    app: App,
    id: ConversationId,
    text: string,
    attachments?: Attachment[],
): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
        ...(attachments === undefined ? {} : { attachments }),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** Save limits against a fresh owner/item/controller/epoch observation. */
export async function setWorkPipLimits(
    app: App,
    id: ConversationId,
    user: User,
    input: { budget?: number | null; maxActions?: number | null },
) {
    const item = (await app.pip.orchestration.inspect(id, user)).orchestration!;

    return app.pip.orchestration.control(id, user, {
        action: "limits",
        ...input,
        expected: {
            workItemId: item.workItemId,
            conversationId: item.conversationId,
            epoch: item.epoch,
        },
    });
}

/** Open privately, optionally set limits, then activate only through an accepted owner message. */
export async function activateWorkPip(
    app: App,
    id: ConversationId,
    user: User = owner(app),
    input: { text?: string; budget?: number | null; maxActions?: number | null } = {},
) {
    const opened = await app.pip.orchestration.control(id, user, { action: "open" });
    const controller = opened.orchestration!.conversationId as ConversationId;

    if (input.budget !== undefined || input.maxActions !== undefined) {
        await setWorkPipLimits(app, id, user, {
            ...(input.budget === undefined ? {} : { budget: input.budget }),
            ...(input.maxActions === undefined ? {} : { maxActions: input.maxActions }),
        });
    }

    await app.commands.submit(controller, user, {
        requestId: crypto.randomUUID(),
        text:
            input.text ??
            "Read the current Work Item context and observe its next meaningful outcome.",
    });

    return app.pip.orchestration.inspect(id, user);
}

/** Real human input and the registered handoff tool create setup transfers, never direct admission. */
export async function executeHandoff(
    app: App,
    id: ConversationId,
    targetType: string,
    options: {
        relationship?: Relationship;
        summary?: string;
        instructions?: string;
        user?: User;
    } = {},
): Promise<HandoffResult> {
    const relationship = options.relationship ?? "same-work";
    const body = [
        `/handoff ${targetType} ${relationship === "new-work" ? "--new" : "--same"}`,
        `Instructions: ${options.instructions ?? "Continue this bounded fixture task."}`,
        `Fixture request: ${crypto.randomUUID()}`,
    ].join("\n");
    const call = fauxToolCall("handoff", {
        action: "start",
        targetType,
        relationship,
        summary: options.summary ?? "Inspect this disposable fixture independently.",
    });

    handoffScripts.set(body, call);

    try {
        const submitted = await app.commands.submit(id, options.user ?? owner(app), {
            text: body,
            requestId: crypto.randomUUID(),
        });
        const submission = await app.harness.submission(submitted.submissionId, context);

        if (submission === undefined) {
            throw new Error("The handoff input was not persisted");
        }

        await submission.wait(context);
        await until(() => !app.isBusy(id), "the handoff tool response settles");

        const records = (await app.harness.snapshot(HandoffsDoc, context))?.handoffs ?? {};
        const record = Object.values(records).find(
            (entry) =>
                entry.sourceThreadId === Number(id) &&
                entry.requestKey === submitted.handoffRequestKey,
        );

        if (record === undefined) {
            const entries = await (
                await app.conversation(id)
            ).entries({ order: "ascending" }, 200, undefined, context);
            const result = entries.items
                .flatMap((entry) => entry.model ?? [])
                .findLast(
                    (message) => message.role === "toolResult" && message.toolCallId === call.id,
                );

            if (result?.role === "toolResult" && result.isError) {
                throw new Error(
                    result.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\\n"),
                );
            }

            throw new Error("The handoff tool did not persist its transfer receipt");
        }

        return {
            id: record.targetThreadId,
            handoffId: record.id,
            workItemId: record.workItemId,
        };
    } finally {
        handoffScripts.delete(body);
    }
}

/** The texts of a conversation's entries as the model sees them, oldest first. */
export async function modelTexts(app: App, id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages.map((message) => JSON.stringify(message.content));
}

/** A browser tab as the app sees it, recording every event it is sent. Attach it with `app.attach(tab.client)`. */
export function fakeTab(id: ConversationId | undefined, user: User) {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const client: Client = {
        id: `tab-${crypto.randomUUID()}`,
        connection: `connection-${crypto.randomUUID()}`,
        user,
        conversationId: id,
        protocol: 2,
        sentEntries: new Set<number>(),
        orderKey: "",
        send: (event: string, data: unknown) =>
            events.push({ event, data: data as Record<string, unknown> }),
    };
    const last = (event: string) => events.findLast((each) => each.event === event)?.data;
    /** A view field as a browser has it: updates leave out the fields that did not change. */
    const field = (name: string) =>
        events.findLast((each) => each.event === "view" && name in each.data)?.data[name];

    return { client, events, last, field };
}

/** Remove the temporary folder: call from `after`, once the app is closed. */
export function cleanUp(): void {
    rmSync(root, { recursive: true, force: true });
}
