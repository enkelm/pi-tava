/** `/api/c/:id`: one conversation's routes, for people the API has checked may see it. */
import { resolve, sep } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Attachment, SubmitRequest } from "../commands.ts";
import { HttpError } from "../errors.ts";
import type { CommandRequest } from "../extension-commands.ts";
import type { ApplyReviewSuggestion, CommentReview, ResolveReview } from "../reviews.ts";
import { serveImage, sniffImage } from "./assets.ts";
import { receiveUpload } from "./uploads.ts";
import { extensionRoute } from "./extension-routes.ts";
import { type ApiRequest, json, readJson, send, withReadContext } from "./io.ts";

const ENTRY_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
]);

export async function conversationRoutes(
    api: ApiRequest,
    id: ConversationId,
    parts: string[],
): Promise<void> {
    if ((api.request.method ?? "GET") === "GET") {
        return withReadContext(api, (context) => dispatchConversation(api, id, parts, context));
    }

    return dispatchConversation(api, id, parts, BACKGROUND_CONTEXT);
}

async function dispatchConversation(
    api: ApiRequest,
    id: ConversationId,
    parts: string[],
    context: Context,
): Promise<void> {
    const { app, request, response, url, user } = api;
    const method = request.method ?? "GET";
    const [, , third, fourth] = parts;

    if (third === "x") {
        return extensionRoute(api, parts.slice(3), id);
    }

    if (third === "private-agent" && fourth === undefined) {
        response.setHeader("cache-control", "no-store");

        if (method === "GET") {
            return json(response, 200, await app.pip.agents.read(id, user));
        }

        if (method === "POST") {
            const body = await readJson<{ action?: unknown } | null>(request);

            return json(response, 200, await app.pip.agents.act(id, user, body));
        }
    }

    if (third === "orchestrator" && fourth === undefined) {
        if (method === "GET") {
            response.setHeader("cache-control", "no-store");

            return json(response, 200, await app.pip.orchestration.inspect(id, user));
        }

        if (method === "POST") {
            return json(
                response,
                200,
                await app.pip.orchestration.control(
                    id,
                    user,
                    await readJson<Parameters<typeof app.pip.orchestration.control>[2]>(request),
                ),
            );
        }
    }

    if (third === "transfers" && fourth === undefined && method === "GET") {
        return json(response, 200, app.workItems.receipts(id, user));
    }

    if (third === "reviews") {
        if (parts.length > 4) {
            throw new HttpError(404, "No such review route");
        }

        if (fourth === undefined && method === "GET") {
            return json(response, 200, await app.reviews.list(id, user));
        }

        if (fourth === "changes" && method === "GET") {
            return json(response, 200, await app.reviews.changes(id, user, context));
        }

        if (fourth === "diff" && method === "GET") {
            return json(response, 200, {
                diff: await app.reviews.diff(id, user, url.searchParams.get("path") ?? "", context),
            });
        }

        if (fourth === "context" && method === "GET") {
            return json(
                response,
                200,
                await app.reviews.context(id, user, url.searchParams.get("path") ?? "", context),
            );
        }

        if (fourth === "comment" && method === "POST") {
            return json(
                response,
                200,
                await app.reviews.comment(id, user, await readJson<CommentReview>(request)),
            );
        }

        if (fourth === "suggestion" && method === "POST") {
            const result = await app.reviews.applySuggestion(
                id,
                user,
                await readJson<ApplyReviewSuggestion>(request),
            );

            if (result.status !== "applied") {
                throw new HttpError(409, "Could not confirm the edit. Use Check result.");
            }

            return json(response, 200, result);
        }

        if (fourth === "resolve" && method === "POST") {
            await app.reviews.resolve(id, user, await readJson<ResolveReview>(request));

            return json(response, 200, { ok: true });
        }

        throw new HttpError(404, "No such review route");
    }

    if (third === "submit" && method === "GET") {
        const receipt = await app.commands.submissionReceipt(
            id,
            user,
            url.searchParams.get("requestId"),
        );

        if (receipt === undefined) {
            throw new HttpError(404, "No accepted input exists for this request");
        }

        return json(response, 200, receipt);
    }

    if (third === "submit" && method === "POST") {
        const body = await readJson<SubmitRequest>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
            throw new HttpError(400, "attachments must be a list");
        }

        const attachments = (body.attachments ?? []).filter((file): file is Attachment => {
            // Only files this server stored for this conversation.
            return (
                typeof file?.path === "string" &&
                resolve(file.path).startsWith(app.workspace.uploadDirectory(id) + sep)
            );
        });

        return json(response, 200, await app.commands.submit(id, user, { ...body, attachments }));
    }

    if (third === "extension-commands" && fourth === undefined && method === "POST") {
        const body = await readJson<CommandRequest>(request);
        const gone = new AbortController();

        // The browser stopped waiting: so does this request. The run goes on, and a retry finds it.
        response.on("close", () => gone.abort());

        return json(response, 200, await app.extensionCommands.run(id, user, body, gone.signal));
    }

    if (third === "extension-commands" && parts[4] === "stop" && method === "POST") {
        await app.extensionCommands.stop(id, user, Number(fourth));

        return json(response, 200, { ok: true });
    }

    if (third === "edit-queued" && method === "POST") {
        const body = await readJson<{
            submissionId?: unknown;
            text?: unknown;
            expectedText?: unknown;
        } | null>(request);

        await app.commands.editQueued(id, user, body?.submissionId, body?.text, body?.expectedText);

        return json(response, 200, { ok: true });
    }

    if (third === "chat" && method === "POST") {
        const body = await readJson<{
            text?: unknown;
            requestId?: unknown;
            quote?: { entryId?: unknown };
        }>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        const quote =
            typeof body.quote === "object" && body.quote !== null
                ? { entryId: body.quote.entryId }
                : undefined;

        return json(
            response,
            200,
            await app.collab.postChat(id, user, {
                text: body.text,
                requestId: body.requestId,
                ...(quote === undefined ? {} : { quote }),
            }),
        );
    }

    if (third === "react" && method === "POST") {
        const body = await readJson<{ entryId?: unknown; emoji?: unknown }>(request);

        await app.collab.react(id, user, Number(body.entryId), String(body.emoji ?? ""));

        return json(response, 200, { ok: true });
    }

    if (third === "pin" && method === "POST") {
        return json(response, 200, await app.collab.pin(id, user, await readJson(request)));
    }

    if (third === "notes" && method === "POST") {
        const body = await readJson<{ text?: unknown; rev?: unknown }>(request);

        if (typeof body.text !== "string" || typeof body.rev !== "number") {
            throw new HttpError(400, "text and rev are required");
        }

        return json(response, 200, await app.collab.saveNotes(id, user, body.text, body.rev));
    }

    if (third === "turns" && method === "POST") {
        await app.collab.turns(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "typing" && method === "POST") {
        const body = await readJson<{ where?: unknown }>(request);

        app.collab.setTyping(id, user, body.where);

        return json(response, 200, { ok: true });
    }

    if (third === "abort" && method === "POST") {
        await app.commands.abort(id, user);

        return json(response, 200, { ok: true });
    }

    // A failed subagent dealt with: `at` says which failure the person saw.
    if (third === "dismiss" && method === "POST") {
        const body = await readJson<{ at?: unknown }>(request);

        return json(response, 200, await app.commands.dismissSubagent(id, user, body.at));
    }

    if (third === "withdraw" && method === "POST") {
        const body = await readJson<{ submissionId?: number }>(request);

        return json(response, 200, {
            result: await app.commands.withdraw(id, user, Number(body.submissionId)),
        });
    }

    if (third === "configure" && method === "POST") {
        await app.commands.configure(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "reset" && method === "POST") {
        const body = await readJson<{ note?: unknown }>(request);

        await app.commands.reset(id, user, body.note);

        return json(response, 200, { ok: true });
    }

    if (third === "instructions" && method === "POST") {
        const body = await readJson<{ text?: unknown }>(request);

        await app.commands.setInstructions(id, user, body.text);

        return json(response, 200, { ok: true });
    }

    if (third === "plan" && method === "POST") {
        const body = await readJson<{ on?: unknown; approve?: unknown }>(request);

        if (body.approve === true) {
            return json(response, 200, await app.commands.approvePlan(id, user));
        }

        await app.commands.setPlan(id, user, body.on);

        return json(response, 200, { ok: true });
    }

    if (third === "schedules" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.commands.schedule(id, user, await readJson(request)));
    }

    if (
        third === "schedules" &&
        fourth !== undefined &&
        parts[4] === "cancel" &&
        method === "POST"
    ) {
        await app.commands.cancelSchedule(id, user, fourth);

        return json(response, 200, { ok: true });
    }

    if (third === "watch" && method === "POST") {
        const body = await readJson<{ pr?: unknown; stop?: unknown }>(request);

        if (body.stop === true) {
            await app.commands.unwatchPr(id, user);

            return json(response, 200, { ok: true });
        }

        return json(response, 200, await app.commands.watchPr(id, user, body.pr));
    }

    // Memory normally applies here. The owner's pending queue reviews all projects, but never adds or edits: `Memory`
    // checks who may use it, and what it may do with a lesson.
    const pendingMemory = third === "memory" && url.searchParams.get("pending") === "all";

    if (third === "memory" && fourth === undefined) {
        if (method === "GET") {
            return json(response, 200, await app.memory.view(id, user, pendingMemory));
        }

        if (method === "POST") {
            // Saving takes no queue: it would save a lesson as usual.
            if (pendingMemory) {
                throw new HttpError(400, "The pending queue only approves or discards lessons.");
            }

            return json(
                response,
                200,
                await app.memory.remember(id, user, await readJson(request)),
            );
        }
    }

    if (third === "memory" && fourth !== undefined && method === "POST") {
        const action = parts[4];
        const body =
            action === undefined || action === "remove"
                ? await readJson<{ text?: unknown; expectedRevision?: unknown }>(request)
                : undefined;
        const change =
            action === "remove" || action === "approve" || action === "discard"
                ? action
                : action === undefined
                  ? { text: body?.text }
                  : undefined;

        // An approval says what the person saw: it holds only if that is still what waits.
        if (change === "approve") {
            const seen = await readJson<{ text?: unknown; forget?: unknown }>(request);

            return json(
                response,
                200,
                await app.memory.edit(
                    id,
                    user,
                    fourth,
                    change,
                    {
                        text: typeof seen.text === "string" ? seen.text : undefined,
                        forget: seen.forget === true,
                    },
                    pendingMemory,
                ),
            );
        }

        if (change !== undefined) {
            return json(
                response,
                200,
                await app.memory.edit(
                    id,
                    user,
                    fourth,
                    change,
                    undefined,
                    pendingMemory,
                    body?.expectedRevision,
                ),
            );
        }
    }

    if (third === "goal" && method === "POST") {
        const body = await readJson<{ command?: unknown; clear?: unknown }>(request);

        if (body.clear === true) {
            await app.commands.clearGoal(id, user);
        } else {
            await app.commands.setGoal(id, user, body.command);
        }

        return json(response, 200, { ok: true });
    }

    if (third === "worktree" && method === "POST") {
        const body = await readJson<{ remove?: unknown; force?: unknown }>(request);

        if (body.remove !== true) {
            throw new HttpError(400, "Only removing a worktree is asked for here");
        }

        await app.commands.removeWorktree(id, user, body.force);

        return json(response, 200, { ok: true });
    }

    // Whether Pi trusts the session's project, which its own skills wait for; only the owner answers.
    if (third === "trust" && method === "GET") {
        return json(response, 200, await app.projectTrust(id, user));
    }

    if (third === "trust" && method === "POST") {
        const body = await readJson<{ choice?: unknown }>(request);

        if (
            body.choice !== "trust" &&
            body.choice !== "trust-parent" &&
            body.choice !== "distrust"
        ) {
            throw new HttpError(400, "choice must be trust, trust-parent, or distrust");
        }

        return json(response, 200, await app.setProjectTrust(id, user, body.choice));
    }

    if (third === "fork" && method === "POST") {
        return json(response, 200, await app.commands.fork(id, user, await readJson(request)));
    }

    if (third === "resend" && method === "POST") {
        return json(response, 200, await app.commands.resend(id, user, await readJson(request)));
    }

    if (third === "compact" && method === "POST") {
        const body = await readJson<{ instructions?: unknown }>(request);

        if (
            body.instructions !== undefined &&
            body.instructions !== null &&
            typeof body.instructions !== "string"
        ) {
            throw new HttpError(400, "instructions must be text");
        }

        await app.commands.compact(
            id,
            user,
            (body.instructions as string | null | undefined)?.trim() || undefined,
        );

        return json(response, 200, { ok: true });
    }

    if (third === "image" && fourth !== undefined && method === "GET") {
        const image = await app.transcripts.entryImage(id, Number(fourth), Number(parts[4] ?? 0));

        if (image === undefined || !ENTRY_IMAGE_TYPES.has(image.mimeType)) {
            throw new HttpError(404, "No such image");
        }

        // Stored entries never change.
        return send(response, 200, image.data, image.mimeType, {
            "cache-control": "private, max-age=31536000, immutable",
        });
    }

    if (third === "file" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        if (app.locationOf(id) !== undefined) {
            const upload = app.workspace.hostUploadFile(id, requested);

            if (upload !== undefined) {
                return serveImage(request, response, upload);
            }

            const bytes = await app.workspace.imageBytes(id, user, requested, context);
            const type = sniffImage(bytes.subarray(0, 1024));

            if (type === undefined) {
                throw new HttpError(415, "That file is not an image");
            }

            return send(response, 200, bytes, type, {
                "cache-control": "private, no-store",
                "content-security-policy":
                    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
            });
        }

        return serveImage(request, response, app.workspace.conversationFile(user, id, requested));
    }

    if (third === "entry" && fourth !== undefined && method === "GET") {
        const entry = await app.transcripts.fullEntry(id, Number(fourth));

        if (entry === undefined) {
            throw new HttpError(404, "No such entry");
        }

        return json(response, 200, entry);
    }

    if (third === "export" && method === "GET") {
        const { filename, markdown } = await app.transcripts.exportMarkdown(id, user);

        return send(response, 200, markdown, "text/markdown; charset=utf-8", {
            "content-disposition": `attachment; filename="${filename}"`,
        });
    }

    if (third === "changes" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.changes(id, user, context));
    }

    if (third === "changes" && fourth === "diff" && method === "GET") {
        return send(
            response,
            200,
            await app.workspace.changeDiff(id, user, url.searchParams.get("path") ?? "", context),
            "text/plain; charset=utf-8",
        );
    }

    // The folder's files for `@` mentions. A browser that has the newest list says so with `since` and gets only
    // that; a whole list goes compressed when the browser takes it so.
    if (third === "files" && method === "GET") {
        const listing = await app.workspace.fileList(id, user, context);

        if (url.searchParams.get("since") === listing.version) {
            return json(response, 200, { version: listing.version, same: true });
        }

        if (!/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
            return send(response, 200, listing.json, "application/json");
        }

        return send(response, 200, await listing.gzipped(), "application/json", {
            "content-encoding": "gzip",
            vary: "accept-encoding",
        });
    }

    // Prompt templates and skills, for the message box's slash commands.
    if (third === "prompts" && method === "GET") {
        const templates = (await app.promptTemplates(id, user)).map(
            ({ name, description, argumentHint }) => ({
                name,
                description,
                ...(argumentHint === undefined ? {} : { argumentHint }),
            }),
        );
        const skills = (await app.skillCommands(id, user)).map(({ name, description }) => ({
            name: `skill:${name}`,
            description,
            argumentHint: "[what to do]",
            skill: true,
        }));

        return json(response, 200, [...templates, ...skills]);
    }

    if (third === "view" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return json(response, 200, await app.workspace.viewFile(id, user, requested, context));
    }

    if (third === "edit" && method === "POST") {
        // JSON escaping can take six bytes per byte of UTF-8 text; the save boundary checks the decoded byte limit.
        const body = await readJson<{ path?: unknown; text?: unknown; revision?: unknown } | null>(
            request,
            4 * 1024 * 1024,
        );

        return json(
            response,
            200,
            await app.workspace.saveFile(id, user, body?.path, body?.text, body?.revision),
        );
    }

    if (third === "lsp" && method === "POST") {
        if (app.locationOf(id) !== undefined) {
            throw new HttpError(409, "Language services are not available for SSH workspaces.");
        }

        return json(response, 200, await app.languages.handle(id, user, await readJson(request)));
    }

    if (third === "changes" && fourth === "revert" && method === "POST") {
        const body = await readJson<{ path?: unknown }>(request);

        if (typeof body.path !== "string" || body.path === "") {
            throw new HttpError(400, "path is required");
        }

        await app.workspace.revertChange(id, user, body.path);

        return json(response, 200, { ok: true });
    }

    if (third === "branches" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.branches(id, user));
    }

    if (third === "branch" && fourth === undefined && method === "POST") {
        return json(
            response,
            200,
            await app.workspace.switchBranch(id, user, (await readJson(request)) ?? {}),
        );
    }

    if (third === "shell" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.shell.start(id, user, await readJson(request)));
    }

    if (third === "shell" && fourth !== undefined && parts[4] === "stop" && method === "POST") {
        await app.shell.stop(id, user, Number(fourth));

        return json(response, 200, { ok: true });
    }

    if (third === "history" && method === "GET") {
        return json(
            response,
            200,
            await app.transcripts.history(
                id,
                Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER),
            ),
        );
    }

    if (third === "upload" && method === "POST") {
        app.requireSteer(user);

        await app.conversation(id);

        return json(
            response,
            200,
            await receiveUpload(
                request,
                app.workspace.uploadDirectory(id),
                url.searchParams.get("name") ?? "upload",
            ),
        );
    }

    throw new HttpError(404, "Unknown API route");
}
