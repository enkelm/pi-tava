/** Exact native contact: prepare authority, admit through Durable, then fence activation and effects. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
    awaitWithContext,
    BACKGROUND_CONTEXT,
    withAbortSignal,
} from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
    GenerationTask,
    LiveDoc,
    ToolTask,
    hook,
    type CommitPublication,
    type ConversationId,
    type HookApi,
    type ToolExecutionApi,
    type ToolRegistration,
    type Tx,
    type Wrap,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { AgentIdentitiesDoc } from "../agent-identity-docs.ts";
import { PipWorkDoc, SubagentsDoc } from "../docs.ts";
import { HandoffsDoc, type WorkItem } from "../workflow-docs.ts";
import { HttpError, describe } from "../errors.ts";
import { clientKey, requestFor } from "../requests.ts";
import { AgentSupervisionDoc, type AgentContact } from "./agent-supervision.ts";
import {
    AgentContactsDoc,
    type ContactAuthority,
    type ContactsData,
    type ExactContact,
} from "./agent-contacts-doc.ts";
import { AgentContactReports } from "./agent-contact-reports.ts";

const context = BACKGROUND_CONTEXT;
const idOf = (id: number) => id as ConversationId;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const detached = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type Effect = { pins: ContactAuthority[]; signal: AbortController };

export class AgentContacts {
    readonly #app: PocketApp;
    readonly #boot = randomUUID();
    readonly #effects = new AsyncLocalStorage<Effect>();
    readonly #running = new Set<Effect>();
    readonly #lanes = new Map<number, Promise<unknown>>();
    readonly #aborting = new Map<number, Promise<unknown>>();
    readonly #live = new Map<number, number>();
    readonly reports: AgentContactReports;
    #doc: ContactsData = AgentContactsDoc.definition.initial();
    #closing = false;

    constructor(app: PocketApp) {
        this.#app = app;
        this.reports = new AgentContactReports(app);
    }

    #destination(id: ConversationId): string {
        return JSON.stringify([
            this.#app.rootOf(id),
            this.#app.cwdOf(id),
            this.#app.locationOf(id),
        ]);
    }

    #lifecycle(target: ConversationId, mutate: boolean, agentId?: string): void {
        const root = this.#app.rootOf(target);
        const meta = this.#app.sessionMeta(root);

        const ownHelper = target !== root && this.#app.pip.agents.scope(root)?.agentId === agentId;

        if (meta === undefined || (meta.pip !== undefined && !ownHelper)) {
            throw new HttpError(
                409,
                "Choose an accessible work conversation, not another private identity/global assistant namespace.",
            );
        }

        if (target !== root && !this.#app.conversationsOf(root).includes(target)) {
            throw new HttpError(
                409,
                "This exact helper is no longer registered with its native parent.",
            );
        }

        if (mutate) {
            const item = this.#app.workItems.itemFor(root);

            if (
                meta.archived ||
                item?.archived ||
                this.#app.workItems.isReadOnly(root) ||
                this.#app.workItems.isPreparing(root) ||
                (item !== undefined && item.activeThreadId !== Number(root))
            ) {
                throw new HttpError(
                    409,
                    "This exact recipient is archived, retired or handing off. Use its native lifecycle controls and select an exact live recipient; nothing was rerouted.",
                );
            }

            if (this.#app.workItems.executionBlocked(root)) {
                throw new HttpError(
                    409,
                    "Native execution is paused or its writer is borrowed. Return/reclaim the native writer before sending work.",
                );
            }
        }
    }

    #assert(pin: ContactAuthority): void {
        const identity = this.#app.pip.agents.identity(idOf(pin.chatId));
        const user = this.#app.config.userById(pin.ownerId);
        const contact = Object.values(this.#doc.contacts).find(
            (item) => item.requestId === pin.requestId,
        );

        if (
            this.#closing ||
            pin.boot !== this.#boot ||
            !this.#app.config.pipEnabled ||
            identity?.agentId !== pin.agentId ||
            identity.epoch !== pin.agentEpoch ||
            user?.role !== "owner" ||
            user.tokenHash !== pin.tokenHash ||
            this.#doc.epochs[String(pin.target)] !== pin.epoch ||
            contact === undefined ||
            !["prepared", "accepted"].includes(contact.status) ||
            pin.destination !== this.#destination(idOf(pin.target))
        ) {
            throw new HttpError(
                409,
                "The exact input's private source/target authority was revoked or interrupted. A fresh explicit decision is required.",
            );
        }

        this.#app.requireSee(user, idOf(pin.target));
        this.#app.spend.check(user, idOf(pin.target));
        this.#app.spend.check(user, idOf(pin.chatId));
        this.#lifecycle(idOf(pin.target), true, pin.agentId);

        if (pin.workItemId !== undefined) {
            const item = this.#app.workItems.itemFor(idOf(pin.root));

            if (
                item?.id !== pin.workItemId ||
                item.supervisor?.agentId !== pin.agentId ||
                item.supervisor.attachmentEpoch !== pin.attachmentEpoch ||
                !this.#app.pip.agents.supervision.current(item)
            ) {
                throw new HttpError(
                    409,
                    "Native Work Item control was reclaimed or transferred. This input cannot reactivate it.",
                );
            }
        }
    }

    async #check(tx: Tx, pin: ContactAuthority): Promise<void> {
        this.#assert(pin);
        const identity = (await tx.doc(AgentIdentitiesDoc)).items[pin.agentId];
        const doc = await tx.doc(AgentContactsDoc);
        const stored = Object.values(doc.contacts).find((item) => item.requestId === pin.requestId);

        if (
            identity?.epoch !== pin.agentEpoch ||
            identity.deletedAt !== undefined ||
            doc.epochs[String(pin.target)] !== pin.epoch ||
            stored === undefined ||
            !["prepared", "accepted"].includes(stored.status)
        ) {
            throw new HttpError(409, "Private contact authority changed before native activation.");
        }

        if (stored.status === "prepared") {
            const source = await tx.task(stored.sourceTask as ToolExecutionApi["taskId"]);

            if (source === undefined) {
                throw new HttpError(409, "The prepared source invocation no longer exists.");
            }

            await this.#app.pip.agents.supervision.requireInvocation(tx, {
                taskId: source.id,
                conversationId: source.conversationId,
            });
        }

        if (pin.controllerId !== undefined) {
            await this.#app.pip.agents.supervision.requireAttachment(
                tx,
                idOf(pin.controllerId),
                pin.agentId,
                pin.agentEpoch,
                pin.attachmentEpoch!,
            );
            const item = (await tx.doc(HandoffsDoc)).workItems[pin.workItemId!]!;

            if (
                (await tx.doc(PipWorkDoc, idOf(pin.controllerId))).question !== undefined ||
                (item.supervisor?.maxCost !== undefined &&
                    this.#app.spend.workSpent(idOf(pin.root)) >= item.supervisor.maxCost)
            ) {
                throw new HttpError(
                    409,
                    "The native orchestrator needs its owner's correlated answer or an explicit budget change.",
                );
            }
        }
    }

    async #lane<T>(target: number, run: () => Promise<T>): Promise<T> {
        const prior = this.#lanes.get(target) ?? Promise.resolve();
        const next = prior.catch(() => {}).then(run);

        this.#lanes.set(target, next);

        try {
            return await next;
        } finally {
            if (this.#lanes.get(target) === next) {
                this.#lanes.delete(target);
            }
        }
    }

    /** Capture the actual source, not whichever private chat is selected when an await completes. */
    #reader(api: ToolExecutionApi, ctx: Context) {
        const source = this.#app.rootOf(api.conversationId);
        const identity = this.#app.pip.agents.identity(source);
        const owner =
            identity === undefined ? undefined : this.#app.config.userById(identity.ownerId);
        const token = owner?.tokenHash;

        const assert = () => {
            const current = this.#app.pip.agents.identity(source);
            const user =
                identity === undefined ? undefined : this.#app.config.userById(identity.ownerId);

            if (
                identity === undefined ||
                current?.agentId !== identity.agentId ||
                current.epoch !== identity.epoch ||
                user?.role !== "owner" ||
                user.tokenHash !== token ||
                !this.#app.config.pipEnabled
            ) {
                throw new HttpError(403, "This private history reader's source authority changed.");
            }

            this.#app.requireSee(user, api.conversationId);
        };

        return async () => {
            assert();
            await api.commit(
                (tx) => this.#app.pip.agents.supervision.requireInvocation(tx, api),
                ctx,
            );
            assert();
        };
    }

    async discover(
        api: ToolExecutionApi,
        filter: Parameters<PocketApp["pip"]["sessions"]>[1],
        ctx: Context,
    ) {
        await this.#reader(api, ctx)();

        return this.#app.pip.sessions(api.conversationId, filter);
    }

    /** Passive history has invocation/visibility fences, never contact receipts or native control. */
    async read(api: ToolExecutionApi, session: number, ctx: Context, entries?: number) {
        if (!Number.isSafeInteger(session) || session <= 0) {
            throw new HttpError(400, "Choose an exact readable conversation.");
        }

        const check = this.#reader(api, ctx);
        const result = await this.#app.pip.read(api.conversationId, session, entries, check);

        return {
            status: "accepted" as const,
            session,
            result,
            requestId: undefined,
            submissionId: undefined,
            reason: undefined,
        };
    }

    async #requireContactAllowance(
        tx: Tx,
        root: ConversationId,
        attachment: WorkItem["supervisor"],
    ): Promise<void> {
        if (
            attachment !== undefined &&
            ((await tx.doc(PipWorkDoc, idOf(attachment.conversationId))).question !== undefined ||
                (attachment.maxActions !== undefined &&
                    attachment.actions >= attachment.maxActions) ||
                (attachment.maxCost !== undefined &&
                    this.#app.spend.workSpent(root) >= attachment.maxCost))
        ) {
            throw new HttpError(
                409,
                "The native orchestrator requires an owner answer or has exhausted its action/spend cap.",
            );
        }
    }

    /** Passive send admission shared by unified handoff status and fresh exact contacts. */
    async requireSendRecipient(api: ToolExecutionApi, session: number, ctx: Context): Promise<void> {
        const target = idOf(session);
        const identity = this.#app.pip.agents.identity(this.#app.rootOf(api.conversationId));
        const user = identity === undefined ? undefined : this.#app.config.userById(identity.ownerId);

        if (identity === undefined || user?.role !== "owner") {
            throw new HttpError(403, "Use this persistent agent's current native invocation.");
        }

        await api.commit((tx) => this.#app.pip.agents.supervision.requireInvocation(tx, api), ctx);
        this.#app.requireSee(user, target);
        this.#lifecycle(target, true, identity.agentId);
        this.#app.spend.check(user, target);
        const recipient = await this.#app.conversation(target);
        const resolved = await recipient.agent(ctx);

        if (!resolved.extensions.some((extension) => extension.name === "pocket-core")) {
            throw new HttpError(409, "This recipient disabled pocket-core's native activation/effect fences. Restore its native lifecycle extension before private input; no tools or access were added.");
        }

        this.#lifecycle(target, true, identity.agentId);
        this.#app.requireSee(user, target);
        await api.commit(async (tx) => {
            await this.#app.pip.agents.supervision.requireInvocation(tx, api);
            const root = this.#app.rootOf(target);
            const item = this.#app.workItems.itemFor(root);
            const attachment =
                item === undefined
                    ? undefined
                    : (await tx.doc(HandoffsDoc)).workItems[item.id]?.supervisor;

            await this.#requireContactAllowance(tx, root, attachment);
        }, ctx);
    }

    async contact(api: ToolExecutionApi, args: AgentContact, ctx: Context) {
        if (args.action === "read") {
            return this.read(api, args.session, ctx);
        }

        if (args.action === "delegate") {
            throw new HttpError(400, "Delegate through the native Work Item orchestrator.");
        }

        const target = idOf(args.session);
        const root = this.#app.rootOf(target);
        const sourceChat = this.#app.rootOf(api.conversationId);
        const scope = this.#app.pip.agents.scope(sourceChat);
        const identity =
            scope === undefined ? undefined : this.#app.pip.agents.identity(sourceChat);
        const user =
            identity === undefined ? undefined : this.#app.config.userById(identity.ownerId);

        if (identity === undefined || user?.role !== "owner") {
            throw new HttpError(403, "Use this persistent agent's current native invocation.");
        }

        await api.commit((tx) => this.#app.pip.agents.supervision.requireInvocation(tx, api), ctx);
        this.#app.requireSee(user, target);
        this.#lifecycle(target, false, identity.agentId);
        const key = hash([api.conversationId, api.taskId, api.callId]);
        const fingerprint = hash(args);
        const previous = (await this.#app.harness.snapshot(AgentContactsDoc, ctx))?.contacts[key];

        if (previous !== undefined) {
            if (previous.fingerprint !== fingerprint) {
                throw new HttpError(
                    409,
                    "This native contact invocation already has different arguments.",
                );
            }

            return this.#result(previous);
        }

        // Passive public-thread observation does not steal an existing controller grant. Mutating
        // contacts still require the one controlling parent; Chats/helpers remain exact recipients.
        const mutates = args.action === "send" || args.action === "stop";
        const current = this.#app.workItems.itemFor(root)?.supervisor;
        const observeOnly =
            !mutates && current !== undefined && current.agentId !== identity.agentId;

        if (!observeOnly && (this.#app.sessionMeta(root)?.threadType ?? "worker") !== "chat") {
            await this.#app.pip.agents.supervision.associate(api, Number(root), user, ctx, true);
        }

        const entries = await this.#app.transcripts.allEntries(target, true);

        if (args.action === "send") {
            await this.requireSendRecipient(api, Number(target), ctx);
            await this.#app.pip.agents.execution.release(sourceChat);
        }

        const observedEpoch = await api.memo(
            `private-contact-target-${api.callId}`,
            this.#doc.epochs[String(target)] ?? 1,
            ctx,
        );

        return this.#lane(Number(target), () =>
            this.#app.workItems.withControl(root, async () => {
                const prepared = await api.commit(async (tx) => {
                    await this.#app.pip.agents.supervision.requireInvocation(tx, api);
                    this.#lifecycle(target, mutates, identity.agentId);
                    this.#app.requireSee(user, target);
                    const doc = await tx.doc(AgentContactsDoc);
                    const item = this.#app.workItems.itemFor(root);
                    const attachment =
                        item === undefined
                            ? undefined
                            : (await tx.doc(HandoffsDoc)).workItems[item.id]?.supervisor;
                    const epoch = doc.epochs[String(target)] ?? 1;
                    const sourceAuthority = (await tx.doc(AgentSupervisionDoc)).toolAuthorities?.[
                        String(api.taskId)
                    ];

                    if (epoch !== observedEpoch) {
                        throw new HttpError(
                            409,
                            "The exact target was stopped or reclaimed while this command waited. It was not admitted.",
                        );
                    }

                    if (Object.keys(doc.contacts).length >= 10000) {
                        throw new HttpError(
                            409,
                            "The durable contact receipt limit was reached; history was not discarded.",
                        );
                    }

                    doc.epochs[String(target)] ??= epoch;
                    const contact: ExactContact = {
                        fingerprint,
                        agentId: identity.agentId,
                        ownerId: user.id,
                        tokenHash: user.tokenHash,
                        agentEpoch: identity.epoch,
                        chatId: Number(sourceChat),
                        requestId: `agent-contact-${key}`,
                        target: Number(target),
                        root: Number(root),
                        epoch,
                        boot: this.#boot,
                        destination: this.#destination(target),
                        sourceInputId: sourceAuthority?.inputId,
                        sourceAdmissionSerial: sourceAuthority?.admissionSerial,
                        ...(item === undefined
                            ? {}
                            : {
                                  workItemId: item.id,
                                  controllerId: attachment!.conversationId,
                                  ...(attachment!.attachmentEpoch === undefined
                                      ? {}
                                      : { attachmentEpoch: attachment!.attachmentEpoch }),
                              }),
                        agentName: identity.record.name,
                        action: args.action as ExactContact["action"],
                        text: args.text ?? "",
                        steer: args.steer === true,
                        report: args.report ?? args.action !== "read",
                        nativeRequestId: requestFor(user.id, clientKey(`agent-contact-${key}`)),
                        sourceTask: Number(api.taskId),
                        status: "prepared",
                        afterEntry: entries.at(-1)?.id ?? 0,
                    };

                    if (mutates && attachment !== undefined) {
                        await this.#requireContactAllowance(tx, root, attachment);
                        attachment.actions++;
                    }

                    doc.contacts[key] = contact;

                    return detached(contact);
                }, ctx);

                try {
                    if (args.action === "send") {
                        const native = await api.conversation(target, ctx);

                        if (native === undefined) {
                            throw new HttpError(404, "The exact recipient no longer exists.");
                        }

                        await api.commit((tx) => this.#check(tx, prepared), ctx);
                        const accepted = await this.#app.commands.submit(
                            target,
                            user,
                            {
                                text: prepared.text,
                                requestId: prepared.requestId,
                                mode: prepared.steer ? "steer" : "followUp",
                            },
                            `named agent ${JSON.stringify(prepared.agentName)} · origin /s/${prepared.chatId}`,
                            native,
                        );

                        await api.commit(async (tx) => {
                            await this.#check(tx, prepared);
                            const stored = (await tx.doc(AgentContactsDoc)).contacts[key]!;

                            stored.submissionId = Number(accepted.submissionId);
                            stored.status = "accepted";
                        }, ctx);
                    } else if (args.action === "stop") {
                        await api.commit(async (tx) => {
                            await this.#app.pip.agents.supervision.requireInvocation(tx, api);
                            const doc = await tx.doc(AgentContactsDoc);

                            doc.epochs[String(target)] = prepared.epoch + 1;
                            doc.contacts[key]!.status = "accepted";
                        }, ctx);
                        const native = await api.conversation(target, ctx);

                        await native!.abort(ctx, { background: true });
                    } else {
                        await api.commit(async (tx) => {
                            await this.#app.pip.agents.supervision.requireInvocation(tx, api);
                            (await tx.doc(AgentContactsDoc)).contacts[key]!.status = "accepted";
                        }, ctx);
                    }

                    return {
                        ...this.#result(
                            (await this.#app.harness.snapshot(AgentContactsDoc, ctx))!.contacts[
                                key
                            ]!,
                        ),
                        ...(args.action === "read" || args.action === "follow"
                            ? {
                                  result: JSON.stringify({
                                      session: Number(target),
                                      entries: entries.slice(-40),
                                      following: args.action === "follow",
                                  }),
                              }
                            : {}),
                    };
                } catch (error) {
                    const admitted = await this.#app.harness.commit(async (tx) => {
                        const stored = (await tx.doc(AgentContactsDoc)).contacts[key];
                        const native =
                            stored?.action === "send"
                                ? await tx.submissionByRequest(target, stored.nativeRequestId)
                                : undefined;

                        if (stored !== undefined) {
                            if (native !== undefined) {
                                stored.submissionId = Number(native.id);
                            }

                            stored.status = native === undefined ? "blocked" : "revoked";
                            stored.reason =
                                native === undefined
                                    ? describe(error)
                                    : `Native input ${native.id} was accepted at /s/${target} but its authority was interrupted: ${describe(error)}. Inspect that exact receipt/history before deciding again; cancellation cannot undo completed effects.`;
                        }

                        return native === undefined ? undefined : stored!.reason;
                    }, context);

                    if (admitted !== undefined) {
                        throw new HttpError(409, admitted);
                    }

                    throw error;
                }
            }),
        );
    }

    #result(contact: ExactContact) {
        return {
            status: contact.status,
            session: contact.target,
            requestId: contact.requestId,
            submissionId: contact.submissionId,
            reason: contact.reason,
        };
    }

    /** A direct same-identity helper input is an admitted native contact, not a forged reporter request. */
    async helperAuthority(
        tx: Tx,
        child: ConversationId,
        requestId: string | undefined,
        agentId: string,
    ) {
        const doc = await tx.doc(AgentContactsDoc);
        const contact = Object.values(doc.contacts).find(
            (item) =>
                item.target === Number(child) &&
                item.nativeRequestId === requestId &&
                item.agentId === agentId &&
                item.action === "send",
        );

        if (contact === undefined) {
            return undefined;
        }

        await this.#check(tx, contact);

        return {
            agentId,
            epoch: contact.agentEpoch,
            tokenHash: contact.tokenHash,
            chatId: Number(this.#app.rootOf(child)),
            inputId: contact.sourceInputId,
            admissionSerial: contact.sourceAdmissionSerial,
        };
    }

    /** Called inside native Stop/reclaim transactions, before any cancellation or admission can race. */
    async fenceTarget(tx: Tx, root: ConversationId): Promise<void> {
        const doc = await tx.doc(AgentContactsDoc);

        for (const target of this.#app.conversationsOf(root)) {
            doc.epochs[String(target)] = (doc.epochs[String(target)] ?? 1) + 1;
        }
    }

    async settleRevoked(): Promise<void> {
        await this.#joinRevoked();
    }

    /** A native send's settlement belongs to its exact origin, including failures and disabled reports. */
    async ownsOutcome(
        tx: Tx,
        target: ConversationId,
        outcome: { answer?: number; submission?: number },
    ): Promise<boolean> {
        if (outcome.answer === undefined && outcome.submission === undefined) {
            return false;
        }

        const doc = await tx.doc(AgentContactsDoc);

        for (const sent of Object.values(doc.contacts)) {
            if (sent.action !== "send" || sent.target !== Number(target)) {
                continue;
            }

            const record = await tx.submissionByRequest(target, sent.nativeRequestId);

            if (
                record?.type === "input" &&
                ((outcome.submission !== undefined && Number(record.id) === outcome.submission) ||
                    (outcome.answer !== undefined &&
                        record.status === "done" &&
                        Number(record.answer) === outcome.answer))
            ) {
                return true;
            }
        }

        return false;
    }

    async requireInvocation(
        tx: Tx,
        api: Pick<ToolExecutionApi, "conversationId" | "taskId">,
    ): Promise<void> {
        await this.#tool(tx, api);
    }

    async #inherited(
        tx: Tx,
        child: ConversationId,
        requestId: string | undefined,
    ): Promise<ContactAuthority[]> {
        const parent = (await tx.conversation(child))?.owner?.conversationId;

        if (parent === undefined || requestId === undefined) {
            return [];
        }

        const doc = await tx.doc(AgentContactsDoc);
        const reporters = (await tx.doc(SubagentsDoc, parent)).reporters;

        for (const [creator, reporterId] of Object.entries(reporters)) {
            const pins = doc.tools[creator];
            const reporter = await tx.task(reporterId);

            if (
                pins?.some(
                    (pin) => requestId === requestFor(pin.ownerId, `subagent-${reporterId}`),
                ) &&
                (reporter?.input as { conversationId?: number })?.conversationId ===
                    Number(child) &&
                !reporter?.abortRequested
            ) {
                return detached(pins);
            }
        }

        return [];
    }

    async #generation(api: HookApi, ctx: Context): Promise<void> {
        const starting = await this.#app.harness.snapshot(LiveDoc, api.conversationId, ctx);
        const requests = new Map<number, string | undefined>();

        for (const input of starting?.run?.inputs ?? []) {
            requests.set(
                Number(input),
                (await (await this.#app.harness.submission(input, ctx))?.status(ctx))?.requestId,
            );
        }

        const pins = await this.#app.harness.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, api.conversationId);
            const doc = await tx.doc(AgentContactsDoc);
            const collected: ContactAuthority[] = [];

            if (live.run?.taskId !== api.taskId) {
                return [];
            }

            for (const input of live.run.inputs) {
                const requestId = requests.get(Number(input));
                const receipt = Object.values(doc.contacts).find(
                    (item) =>
                        item.target === Number(api.conversationId) &&
                        item.nativeRequestId === requestId &&
                        item.action === "send",
                );

                if (receipt !== undefined) {
                    const native = await tx.submissionByRequest(
                        api.conversationId,
                        receipt.nativeRequestId,
                    );

                    if (native?.id !== input) {
                        throw new HttpError(
                            409,
                            "Native exact-target admission no longer matches this private input.",
                        );
                    }

                    await this.#check(tx, receipt);
                    receipt.submissionId = Number(input);
                    receipt.status = "accepted";
                    collected.push(detached(receipt));
                } else {
                    if (requestId?.startsWith("p:") && requestId.includes(":agent-contact-")) {
                        throw new HttpError(
                            409,
                            "This private input has no durable exact-recipient intent; it cannot activate as ordinary owner input.",
                        );
                    }

                    collected.push(...(await this.#inherited(tx, api.conversationId, requestId)));
                }
            }

            for (const pin of collected) {
                await this.#check(tx, pin);
            }

            if (collected.length > 0) {
                doc.generations[String(api.taskId)] = collected;
            }

            return collected;
        }, ctx);

        for (const pin of pins) {
            this.#assert(pin);
        }
    }

    async #tool(
        tx: Tx,
        api: Pick<ToolExecutionApi, "conversationId" | "taskId">,
    ): Promise<ContactAuthority[]> {
        const doc = await tx.doc(AgentContactsDoc);
        let task = await tx.task(api.taskId);
        const live = await tx.doc(LiveDoc, api.conversationId);
        const seen = new Set<number>();

        while (task !== undefined && !seen.has(Number(task.id)) && seen.size < 32) {
            seen.add(Number(task.id));

            if (task.abortRequested || task.state.status === "terminal") {
                throw new HttpError(409, "Native invocation is no longer live.");
            }

            if (task.id === live.run?.taskId) {
                const pins = doc.generations[String(task.id)] ?? [];

                for (const pin of pins) {
                    await this.#check(tx, pin);
                }

                return detached(pins);
            }

            task = task.owner === undefined ? undefined : await tx.task(task.owner);
        }

        const pins = doc.tools[String(api.taskId)] ?? [];

        if (pins.length > 0) {
            throw new HttpError(409, "The private-derived native invocation was retired.");
        }

        return [];
    }

    readonly hooks = [
        hook(GenerationTask, {
            beforeRequest: async (_request, api, ctx) => {
                try {
                    await this.#generation(api, ctx);
                } catch (error) {
                    await awaitWithContext(this.#app.harness.abortTask(api.taskId, context), ctx);

                    throw error;
                }
            },
        }),
        hook(ToolTask, {
            beforeTool: async (_call, api, ctx) => {
                try {
                    await this.#app.harness.commit(async (tx) => {
                        const pins = await this.#tool(tx, api);

                        if (pins.length > 0) {
                            (await tx.doc(AgentContactsDoc)).tools[String(api.taskId)] = pins;
                        }
                    }, ctx);
                } catch (error) {
                    await awaitWithContext(this.#app.harness.abortTask(api.taskId, context), ctx);

                    throw error;
                }
            },
        }),
    ];

    /** Wrap real selected descriptors by the public Wrap API. This adds no tools or grants.
     * Safe replay skips beforeTool; helper/control effects need the same execution-time guard
     * as coding. Unknown extension effects remain refused by workflow-policy before intent.
     */
    readonly wraps: readonly Wrap[] = [
        "read",
        "write",
        "edit",
        "bash",
        "codemode",
        "host_skill",
        "subagent",
        "handoff",
        "research",
        "browser",
        "pull",
        "publication",
        "stage_upload",
        "review_comment",
        "artifact",
        "team",
        "work_handoff",
        "work_supervise",
        "agent_execution",
        "agent_work",
        "agent_charter",
        "memory",
        "sessions",
        "session_read",
        "work_context",
        "work_review",
        "session_start",
        "session_send",
        "session_follow",
        "session_stop",
        "session_archive",
        "approvals",
        "schedule",
        "session_schedule",
        "watch_pr",
        "session_watch_pr",
        "repo_watch",
    ].map((name): Wrap => ({
        tool: name,
        wrap: (tool: ToolRegistration): ToolRegistration => ({
            ...tool,
            execute: (args, api, ctx) =>
                this.#run(api, ctx, (bound, scoped) => tool.execute(args, bound, scoped)),
        }),
    }));

    async #run<T>(
        api: ToolExecutionApi,
        ctx: Context,
        run: (api: ToolExecutionApi, ctx: Context) => Promise<T>,
    ): Promise<T> {
        const pins = await api.commit((tx) => this.#tool(tx, api), ctx);

        if (pins.length === 0) {
            return run(api, ctx);
        }

        const effect: Effect = { pins, signal: new AbortController() };

        this.#running.add(effect);

        try {
            return await this.#effects.run(effect, () =>
                run(
                    { ...api, env: this.#app.envFor(api.conversationId) },
                    withAbortSignal(
                        AbortSignal.any([
                            effect.signal.signal,
                            ...(ctx.abortSignal ? [ctx.abortSignal] : []),
                        ]),
                        ctx,
                    ),
                ),
            );
        } finally {
            this.#running.delete(effect);
        }
    }

    assertEffects(id: ConversationId): void {
        const pins =
            this.#effects.getStore()?.pins ??
            this.#doc.generations[String(this.#live.get(Number(id)))] ??
            [];

        for (const pin of pins) {
            this.#assert(pin);
        }
    }

    isDerived(id: ConversationId): boolean {
        return (
            (this.#effects.getStore()?.pins.length ??
                this.#doc.generations[String(this.#live.get(Number(id)))]?.length ??
                0) > 0
        );
    }

    async humanInput<T>(id: ConversationId, run: () => Promise<T>): Promise<T> {
        return this.#lane(Number(id), async () => {
            const affected = Object.values(this.#doc.contacts).filter(
                (item) =>
                    item.target === Number(id) &&
                    item.action === "send" &&
                    ["prepared", "accepted"].includes(item.status),
            );

            if (affected.length > 0) {
                await this.#app.harness.commit(async (tx) => {
                    const doc = await tx.doc(AgentContactsDoc);

                    doc.epochs[String(id)] = (doc.epochs[String(id)] ?? 1) + 1;

                    for (const item of Object.values(doc.contacts)) {
                        if (item.target === Number(id) && item.action === "send") {
                            item.status = "revoked";
                        }
                    }
                }, context);
                await this.#joinRevoked();
            }

            return run();
        });
    }

    committed(publication: CommitPublication): void {
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === AgentContactsDoc.definition.kind
            ) {
                this.#doc = detached(change.value as ContactsData);
            }

            if (change.type === "document" && change.record.kind === LiveDoc.definition.kind) {
                const live = change.value as { run?: { taskId: number } } | null;

                if (live?.run === undefined) {
                    this.#live.delete(Number(change.conversationId));
                } else {
                    this.#live.set(Number(change.conversationId), Number(live.run.taskId));
                }
            }
        }

        this.changed();
        this.reports.committed(publication);
    }

    changed(): void {
        for (const effect of this.#running) {
            try {
                effect.pins.forEach((pin) => this.#assert(pin));
            } catch {
                effect.signal.abort();
            }
        }

        for (const [task, pins] of [
            ...Object.entries(this.#doc.generations),
            ...Object.entries(this.#doc.tools),
        ]) {
            try {
                pins.forEach((pin) => this.#assert(pin));
            } catch {
                const taskId = Number(task);

                if (!this.#aborting.has(taskId)) {
                    const abort = this.#app.harness.abortTask(
                        taskId as ToolExecutionApi["taskId"],
                        context,
                    );

                    this.#aborting.set(taskId, abort);
                    void abort.catch(() => {});
                }
            }
        }
    }

    async #joinRevoked(): Promise<void> {
        this.changed();
        await Promise.allSettled(this.#aborting.values());

        if (Object.keys(this.#doc.contacts).length === 0) {
            return;
        }

        const inspection = await this.#app.harness.inspect(context);

        for (const submission of inspection.submissions) {
            const contact = Object.values(this.#doc.contacts).find(
                (item) =>
                    item.nativeRequestId === submission.requestId &&
                    item.target === Number(submission.conversationId),
            );

            if (contact !== undefined) {
                try {
                    this.#assert(contact);
                } catch {
                    await this.#app.harness.abortSubmission(
                        submission.id,
                        context,
                        submission.conversationId,
                    );
                }
            }
        }
    }

    /** Pure durable fencing precedes any abort API, which can resume another native task. */
    async prepareRecovery(): Promise<void> {
        this.#doc = detached(
            (await this.#app.harness.snapshot(AgentContactsDoc, context)) ??
                AgentContactsDoc.definition.initial(),
        );
        const inspection = await this.#app.harness.inspect(context);
        const pending = new Set(
            inspection.submissions.map((item) => `${item.conversationId}:${item.requestId}`),
        );

        for (const id of new Set(inspection.tasks.map((task) => task.record.conversationId))) {
            const live = await this.#app.harness.snapshot(LiveDoc, id, context);

            if (live?.run !== undefined) {
                this.#live.set(Number(id), Number(live.run.taskId));
            }
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(AgentContactsDoc);

            for (const contact of Object.values(doc.contacts)) {
                if (
                    contact.action === "send" &&
                    (contact.status === "prepared" ||
                        pending.has(`${contact.target}:${contact.nativeRequestId}`))
                ) {
                    contact.status = "revoked";
                    contact.reason =
                        "Native private activation interrupted by restart; inspect outcome and make a fresh explicit decision.";
                }
            }
        }, context);
        this.#doc = detached((await this.#app.harness.snapshot(AgentContactsDoc, context))!);
    }

    async recover(): Promise<void> {
        await this.#joinRevoked();
    }

    observations(agentId: string, epoch: number) {
        return Object.values(this.#doc.contacts)
            .filter(
                (contact) =>
                    contact.agentId === agentId &&
                    contact.agentEpoch === epoch &&
                    contact.status === "accepted" &&
                    ["read", "follow"].includes(contact.action),
            )
            .map((contact) => ({
                target: contact.target,
                workItemId: contact.workItemId,
                heldReason:
                    this.#app.config.userById(contact.ownerId)?.tokenHash !== contact.tokenHash
                        ? "The observing source's sign-in changed; a fresh owner decision is required."
                        : Object.values(this.#doc.reports).findLast(
                              (report) =>
                                  report.originRequestId === contact.requestId &&
                                  report.status === "held",
                          )?.reason,
            }));
    }

    async open(): Promise<void> {
        await this.reports.open();
    }

    async close(): Promise<void> {
        this.#closing = true;
        this.changed();
        await this.#joinRevoked();
        await this.reports.close();
    }
}
