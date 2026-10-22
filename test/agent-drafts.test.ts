// The real draft client owns local disposal, first-send request identity and navigation fencing.
// Native HTTP tests own persistence, input admission and private History authorization.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function fixture(storage = new Map<string, string>()) {
    const requests: {
        path: string;
        body: unknown;
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
    }[] = [];
    const navigations: unknown[] = [];
    let next = 0;
    const store = {
        state: {
            me: { id: "owner", role: "owner" },
            server: { privateAgents: 4 },
            namedAgents: [{ agentId: "ada" }, { agentId: "bea" }],
            agentDraft: null as null | { id: string; agentId: string },
        },
        set(patch: object) {
            Object.assign(this.state, patch);
        },
    };
    const source = readFileSync(new URL("../web/agent-drafts.js", import.meta.url), "utf8")
        .replace(/^import .*;$/gm, "")
        .replace(/export /g, "");
    const draft = runInNewContext(
        `${source}\n({openAgentDraft, agentDrafts, selectAgentDraft, selectedAgentDraft, updateAgentDraft, closeAgentDraft, sendAgentDraft, recoverAgentDraft})`,
        {
            store,
            uid: () => `request-${++next}`,
            sessionStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
            },
            navigate: (
                id: number | null,
                options?: { agentDraft: { id: string; agentId: string } },
            ) => {
                navigations.push(id ?? options?.agentDraft.id);
                store.state.agentDraft = options?.agentDraft ?? null;
            },
            api: (path: string, body?: unknown) =>
                new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })),
        },
    );

    return { draft, requests, navigations, store, storage };
}

const receipt = (id: number, agentId = "ada") => ({
    id,
    agentId,
    submissionId: 10,
    requestId: "native-owner-request",
});

test("opening and closing unused per-agent drafts never calls the server or retains a History candidate", () => {
    const f = fixture();
    const first = f.draft.openAgentDraft("ada");
    const other = f.draft.openAgentDraft("bea");

    f.draft.updateAgentDraft(first.id, "Unsent text");
    assert.equal(f.draft.agentDrafts("ada")[0].text, "Unsent text");
    assert.equal(f.draft.agentDrafts("bea")[0].id, other.id);
    f.draft.closeAgentDraft(first.id);
    assert.equal(f.draft.agentDrafts("ada").length, 0);
    assert.equal(f.draft.agentDrafts("bea").length, 1);
    assert.equal(f.requests.length, 0, "viewing, typing, + and Close are UI-only");
    const reloaded = fixture(f.storage);

    assert.equal(reloaded.draft.agentDrafts("ada").length, 0);
    assert.equal(reloaded.draft.agentDrafts("bea").length, 1);
    reloaded.store.state.me = { id: "other-owner", role: "owner" };
    assert.equal(reloaded.draft.agentDrafts("bea").length, 0, "local drafts are owner-scoped");
    reloaded.store.state.me = { id: "guest", role: "guest" };
    assert.equal(reloaded.draft.openAgentDraft("ada"), undefined);
    assert.equal(reloaded.requests.length, 0);
});

test("double send shares one first-send request; switching or closing the origin never reroutes acceptance", async () => {
    const f = fixture();
    const origin = f.draft.openAgentDraft("ada");

    f.draft.updateAgentDraft(origin.id, "Keep my report here");
    const first = f.draft.sendAgentDraft(origin.id);
    const second = f.draft.sendAgentDraft(origin.id);

    assert.equal(first, second);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.path, "pip/agents/ada/submit");
    const other = f.draft.openAgentDraft("bea");

    f.draft.closeAgentDraft(origin.id);
    f.requests[0]!.resolve(receipt(101));
    await first;
    assert.equal(f.draft.selectedAgentDraft().id, other.id);
    assert.ok(!f.navigations.includes(101), "late acceptance cannot move the selected Chat");
    assert.equal(f.draft.agentDrafts("ada").length, 0);
    assert.equal(f.requests.length, 1, "closing a view neither stops nor submits work");
});

test("a definitively rejected first send can be corrected and sent with a new request identity", async () => {
    const f = fixture();
    const origin = f.draft.openAgentDraft("ada");

    f.draft.updateAgentDraft(origin.id, "First user message");
    const send = f.draft.sendAgentDraft(origin.id);
    const firstBody = f.requests[0]!.body as { requestId: string };

    f.requests[0]!.reject(
        Object.assign(new Error("Agent is working in another chat"), { status: 409 }),
    );
    await assert.rejects(send, /Agent is working in another chat/);
    assert.equal(f.draft.selectedAgentDraft().text, "First user message");
    f.draft.updateAgentDraft(origin.id, "Corrected intent");
    assert.equal(f.draft.selectedAgentDraft().text, "Corrected intent");
    const reloaded = fixture(f.storage);

    reloaded.draft.selectAgentDraft(origin.id);
    const retry = reloaded.draft.sendAgentDraft(origin.id);
    const corrected = reloaded.requests[0]!.body as { text: string; requestId: string };

    assert.equal(corrected.text, "Corrected intent");
    assert.notEqual(corrected.requestId, firstBody.requestId);
    reloaded.requests[0]!.resolve(receipt(102));
    await retry;
    assert.equal(reloaded.navigations.at(-1), 102);
});

test("an uncertain first send retains its exact payload across reload and a later rejection", async () => {
    const f = fixture();
    const origin = f.draft.openAgentDraft("ada");

    f.draft.updateAgentDraft(origin.id, "First user message");
    const send = f.draft.sendAgentDraft(origin.id);
    const body = JSON.stringify(f.requests[0]!.body);

    f.requests[0]!.reject(new Error("Network interrupted"));
    await assert.rejects(send, /Network interrupted/);
    f.draft.updateAgentDraft(origin.id, "Must not mutate an uncertain request");
    assert.equal(f.draft.selectedAgentDraft().text, "First user message");
    const rejectedRetry = f.draft.sendAgentDraft(origin.id);

    f.requests[1]!.reject(Object.assign(new Error("Agent is unavailable"), { status: 409 }));
    await assert.rejects(rejectedRetry, /Agent is unavailable/);
    f.draft.updateAgentDraft(origin.id, "Still must not mutate an uncertain request");
    assert.equal(f.draft.selectedAgentDraft().text, "First user message");
    const reloaded = fixture(f.storage);

    reloaded.draft.selectAgentDraft(origin.id);
    const check = reloaded.draft.recoverAgentDraft(origin.id);

    assert.equal(
        reloaded.requests[0]!.body,
        undefined,
        "only a passive GET recovers acknowledgement",
    );
    reloaded.requests[0]!.reject(Object.assign(new Error("Not accepted yet"), { status: 404 }));
    assert.equal(await check, null);
    const retry = reloaded.draft.sendAgentDraft(origin.id);

    assert.equal(JSON.stringify(reloaded.requests[1]!.body), body);
    reloaded.requests[1]!.resolve(receipt(102));
    await retry;
    assert.equal(reloaded.navigations.at(-1), 102);
    assert.equal(reloaded.draft.agentDrafts("ada").length, 0);
});

test("attachment-only first Send freezes staged files and inline intent across uncertain reload", async () => {
    const f = fixture();
    const origin = f.draft.openAgentDraft("ada");
    const composition = {
        text: "",
        attachments: [{ path: "/staged/photo.png", name: "photo.png", mime: "image/png", size: 3 }],
        inlineFiles: true,
    };
    const send = f.draft.sendAgentDraft(origin.id, composition);
    const body = JSON.stringify(f.requests[0]!.body);

    composition.attachments[0]!.name = "must not change pending input";
    f.requests[0]!.reject(new Error("Network interrupted"));
    await assert.rejects(send, /Network interrupted/);
    const reloaded = fixture(f.storage);

    reloaded.draft.selectAgentDraft(origin.id);
    const retry = reloaded.draft.sendAgentDraft(origin.id, {
        text: "different input",
        attachments: [],
    });

    assert.equal(JSON.stringify(reloaded.requests[0]!.body), body);
    assert.equal(
        (reloaded.requests[0]!.body as typeof composition).attachments[0]!.name,
        "photo.png",
    );
    reloaded.requests[0]!.resolve(receipt(104));
    await retry;
    assert.equal(reloaded.navigations.at(-1), 104);
});

test("accepted first-send acknowledgement can be recovered after reload without another POST", async () => {
    const f = fixture();
    const origin = f.draft.openAgentDraft("ada");

    f.draft.updateAgentDraft(origin.id, "Recover accepted input");
    const send = f.draft.sendAgentDraft(origin.id);

    f.requests[0]!.reject(new Error("Network interrupted"));
    await assert.rejects(send);
    const reloaded = fixture(f.storage);

    reloaded.draft.selectAgentDraft(origin.id);
    const recovery = reloaded.draft.recoverAgentDraft(origin.id);

    reloaded.requests[0]!.resolve(receipt(103));
    await recovery;
    assert.equal(reloaded.requests.length, 1);
    assert.equal(reloaded.requests[0]!.body, undefined);
    assert.equal(reloaded.navigations.at(-1), 103);
    assert.equal(reloaded.draft.agentDrafts("ada").length, 0);
});
