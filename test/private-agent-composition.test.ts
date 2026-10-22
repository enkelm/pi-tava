// The HTTP/native boundary owns upload privacy and first-send payload delivery; Composer callbacks live in offline tests.
import "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";
import { splitAttachments } from "../src/server/entry-format.ts";
import { privateAgentRequest as request } from "./private-agent-http.ts";
import { cleanUp, context, lastText, openApp, root, scriptedModel, work } from "./helpers.ts";

after(cleanUp);

test("private draft uploads reserve no Chat; attachment-only and inline-file sends retain exact native receipts", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "private-agent-composition"));

    t.after(() => app.close());
    const before = await app.harness.snapshot(SessionsDoc, context);
    const agents: string[] = [];

    for (const name of ["Ada", "Bea"]) {
        const created = await request(app, "pip/agents?identityOnly=1", {
            requestId: `composition-${name}`,
            name,
        });

        assert.equal(created.status, 200, await created.clone().text());
        const identity = await created.json();

        assert.equal(identity.id, null);
        assert.deepEqual(identity.chats, []);
        agents.push(identity.agentId);
        const configured = await request(app, `pip/agents/${identity.agentId}/configure`, {
            model: { provider: "faux", modelId: "faux-1" },
        });

        assert.equal(configured.status, 200, await configured.clone().text());
    }

    const [ada, bea] = agents;
    const path = `pip/agents/${ada}`;
    const document = { privateDraft: "uploaded before any saved conversation" };
    // The fixture streams JSON bytes: this is an application/json file, not a mocked upload descriptor.
    const uploaded = await request(app, `${path}/upload?name=notes.json`, document);

    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    assert.equal(uploaded.headers.get("cache-control"), "no-store");
    const attachment = await uploaded.json();
    const bytes = JSON.stringify(document);

    assert.equal(attachment.name, "notes.json");
    assert.equal(attachment.mime, "application/json");
    assert.equal(attachment.size, Buffer.byteLength(bytes));
    assert.equal(readFileSync(attachment.path, "utf8"), bytes);

    const inlineName = "composition-inline.txt";
    const inlineBytes = "This unique inline file body was not written in the submitted message.\n";

    writeFileSync(join(work, inlineName), inlineBytes);
    const files = await request(app, `${path}/files`);

    assert.equal(files.status, 200, await files.clone().text());
    assert.equal(files.headers.get("cache-control"), "no-store");
    assert.ok((await files.json()).files.includes(inlineName));

    const { token } = app.config.addUser("Composition guest", "guest");
    const first = {
        requestId: "attachment-only-first",
        text: "",
        attachments: [attachment],
        inlineFiles: false,
    };

    for (const [route, body] of [
        [`${path}/upload?name=guest.json`, document],
        [`${path}/files`, undefined],
        [`${path}/submit`, first],
    ] as const) {
        const denied = await request(app, route, body, token);

        assert.equal(denied.status, 403);
        assert.ok(!(await denied.text()).includes(attachment.path));
    }

    const otherIdentity = await request(app, `pip/agents/${bea}/submit`, first);

    assert.equal(otherIdentity.status, 400);
    assert.match(await otherIdentity.text(), /uploaded for this private agent/);
    assert.deepEqual(
        await app.harness.snapshot(SessionsDoc, context),
        before,
        "uploads, file suggestions and denied sends do not reserve conversations",
    );

    for (const agentId of agents) {
        const identity = await request(app, `pip/agents/${agentId}`);

        assert.equal((await identity.json()).id, null);
    }

    const submitted = await request(app, `${path}/submit`, first);

    assert.equal(submitted.status, 200, await submitted.clone().text());
    const accepted = await submitted.json();
    const chat = accepted.id as ConversationId;
    const submission = await app.harness.submission(accepted.submissionId as SubmissionId, context);

    assert.ok(submission, "the response names an actual native submission");
    await submission.wait(context);
    const receipt = await app.harness.commit(
        (tx) => tx.submissionByRequest(chat, accepted.requestId),
        context,
    );

    assert.equal(receipt?.type, "input");
    assert.equal(receipt?.id, accepted.submissionId);
    assert.equal(receipt?.conversationId, chat);
    assert.equal(receipt?.status, "done");

    const entries = await app.transcripts.allEntries(chat, true);
    const user = entries.find((entry) => entry.kind === "user");

    assert.ok(user?.kind === "user");
    const [written, listed] = splitAttachments(user.text);

    assert.equal(written, "", "an attachment-only send needs no invented user text");
    const fileLine = /^- (.+) \(notes\.json, application\/json, ([0-9]+) bytes\)$/.exec(
        listed ?? "",
    );

    assert.ok(fileLine, "the native attachment marker contains exactly one uploaded file");
    assert.equal(Number(fileLine[2]), Buffer.byteLength(bytes));
    const nativeFile = fileLine[1]!;

    assert.notEqual(
        nativeFile,
        attachment.path,
        "staging paths are not native conversation uploads",
    );
    assert.equal(dirname(nativeFile), app.workspace.uploadDirectory(chat));
    assert.equal(readFileSync(nativeFile, "utf8"), bytes);
    const view = await (await app.conversation(chat)).context(context);
    const nativeUsers = view.messages.filter((message) => message.role === "user");
    const nativeText = lastText({ messages: nativeUsers }).text;

    assert.equal(nativeUsers.length, 1);
    assert.match(nativeText, /Attached files \(saved on the server\)/);
    assert.ok(nativeText.includes(nativeFile));
    assert.ok(nativeText.includes("notes.json"));

    const retry = await request(app, `${path}/submit`, first);
    const passive = await request(app, `${path}/submit?requestId=${first.requestId}`);

    for (const response of [retry, passive]) {
        assert.equal(response.status, 200, await response.clone().text());
        const recovered = await response.json();

        assert.equal(recovered.id, accepted.id);
        assert.equal(recovered.submissionId, receipt!.id);
        assert.equal(recovered.requestId, receipt!.requestId);
    }

    assert.equal(
        (await (await app.conversation(chat)).context(context)).entries.filter(
            (entry) => entry.kind === "pi.user",
        ).length,
        1,
        "accepted retry never appends another native input",
    );
    const foreignReceipt = await request(
        app,
        `pip/agents/${bea}/submit?requestId=${first.requestId}`,
    );

    assert.equal(foreignReceipt.status, 404);
    const guestReceipt = await request(
        app,
        `${path}/submit?requestId=${first.requestId}`,
        undefined,
        token,
    );

    assert.equal(guestReceipt.status, 403);

    const inline = {
        requestId: "inline-first",
        text: `Inspect @${inlineName}`,
        inlineFiles: true,
    };
    const inlineSent = await request(app, `${path}/submit`, inline);

    assert.equal(inlineSent.status, 200, await inlineSent.clone().text());
    const inlineAccepted = await inlineSent.json();
    const inlineChat = inlineAccepted.id as ConversationId;

    assert.notEqual(inlineChat, chat, "a second first send owns a separate saved Chat");
    await (await app.harness.submission(
        inlineAccepted.submissionId as SubmissionId,
        context,
    ))!.wait(context);
    const inlineView = await (await app.conversation(inlineChat)).context(context);
    const inlineText = lastText({
        messages: inlineView.messages.filter((message) => message.role === "user"),
    }).text;

    assert.ok(inlineText.includes('<file name="'));
    assert.ok(
        inlineText.includes(inlineBytes),
        "inlineFiles reaches native file loading, not just JSON admission",
    );
    const changedPayload = await request(app, `${path}/submit`, { ...inline, inlineFiles: false });

    assert.equal(
        changedPayload.status,
        409,
        "an accepted request cannot silently change inlineFiles",
    );
    const history = await request(app, path);
    const sibling = await request(app, `pip/agents/${bea}`);

    assert.deepEqual((await history.json()).chatIds, [accepted.id, inlineAccepted.id]);
    assert.deepEqual((await sibling.json()).chats, []);
});
