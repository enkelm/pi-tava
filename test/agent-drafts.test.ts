// The real draft client owns local disposal, first-send request identity and navigation fencing.
// Native HTTP tests own persistence, input admission and private History authorization.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function fixture(
    storage = new Map<string, string>(),
    server: { privateAgents: number; agentDraftProjects?: number } = {
        privateAgents: 4,
        agentDraftProjects: 1,
    },
) {
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
            server,
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
        `${source}\n({openAgentDraft, agentDrafts, selectAgentDraft, selectedAgentDraft, updateAgentDraft, updateAgentDraftFiles, updateAgentDraftPastes, closeAgentDraft, sendAgentDraft, recoverAgentDraft})`,
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

    return { draft, requests, navigations, store, storage, allocations: () => next };
}

const receipt = (id: number, agentId = "ada") => ({
    id,
    agentId,
    submissionId: 10,
    requestId: "native-owner-request",
});

function assertBackendUpdate(message: string) {
    assert.match(message, /server|backend/i);
    assert.match(message, /updat/i);
    assert.match(message, /restart/i);
    assert.match(message, /reload/i);
}

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

test("an uncertain first send retains its exact payload and Home project across reload and a later rejection", async () => {
    const f = fixture();
    const origin = f.draft.openAgentDraft("ada", { projectId: "chosen-project" });

    f.draft.updateAgentDraft(origin.id, "First user message");
    const send = f.draft.sendAgentDraft(origin.id);
    const body = JSON.stringify(f.requests[0]!.body);

    assert.equal((f.requests[0]!.body as { projectId: string }).projectId, "chosen-project");
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

test("explicit project first Send preflights unsupported servers without freezing or discarding editable input", async (t) => {
    for (const projectId of ["chosen-project", null]) {
        for (const capability of [undefined, 0]) {
            await t.test(
                `project ${JSON.stringify(projectId)}, capability ${capability}`,
                async () => {
                    const f = fixture(undefined, {
                        privateAgents: 4,
                        agentDraftProjects: capability,
                    });
                    const origin = f.draft.openAgentDraft("ada", { projectId });
                    const files = [
                        {
                            state: "done",
                            attachment: { path: "/staged/photo.png", name: "photo.png" },
                        },
                    ];
                    const pastes = { 1: "Expanded pasted text" };

                    f.draft.updateAgentDraft(origin.id, "Review [Pasted text #1]");
                    f.draft.updateAgentDraftFiles(origin.id, files);
                    f.draft.updateAgentDraftPastes(origin.id, pastes);
                    const before = JSON.stringify({ ...origin });
                    const allocations = f.allocations();
                    const send = f.draft.sendAgentDraft(origin.id, {
                        text: "Review Expanded pasted text",
                        attachments: files.map((file) => file.attachment),
                        inlineFiles: true,
                    });

                    assert.equal(
                        f.requests.length,
                        0,
                        "unsupported server receives no first-send POST",
                    );
                    assert.equal(
                        f.allocations(),
                        allocations,
                        "preflight allocates no request identity",
                    );
                    await assert.rejects(send, (error: Error) => {
                        assertBackendUpdate(error.message);

                        return true;
                    });
                    assertBackendUpdate(origin.error);
                    assert.equal(origin.requestId, undefined);
                    assert.equal(origin.payload, undefined);
                    assert.equal(JSON.stringify({ ...origin, error: undefined }), before);
                    assert.equal(f.draft.selectedAgentDraft(), origin);
                    f.draft.updateAgentDraft(origin.id, "Edited after refusal");
                    assert.equal(origin.text, "Edited after refusal");
                    f.store.state.server.agentDraftProjects = 1;
                    await Promise.resolve();
                    assert.equal(f.requests.length, 0, "capability arrival never dispatches input");
                    const retry = f.draft.sendAgentDraft(origin.id);
                    const body = f.requests[0]!.body as { text: string; projectId: string | null };

                    assert.equal(body.projectId, projectId);
                    assert.equal(body.text, "Edited after refusal");
                    f.requests[0]!.resolve(receipt(105));
                    await retry;
                    assert.equal(f.navigations.at(-1), 105);
                },
            );
        }
    }
});

test("no-project drafts retain legacy Send when project capability is absent or below one", async (t) => {
    for (const capability of [undefined, 0]) {
        await t.test(`capability ${capability}`, async () => {
            const f = fixture(undefined, { privateAgents: 4, agentDraftProjects: capability });
            const origin = f.draft.openAgentDraft("ada", { projectId: undefined });

            f.draft.updateAgentDraft(origin.id, "Legacy first message");
            const send = f.draft.sendAgentDraft(origin.id);
            const body = f.requests[0]!.body as { text: string; projectId?: string | null };

            assert.equal(f.requests.length, 1);
            assert.equal(f.requests[0]!.path, "pip/agents/ada/submit");
            assert.equal(body.projectId, undefined);
            assert.equal(body.text, "Legacy first message");
            f.requests[0]!.resolve(receipt(106));
            await send;
        });
    }
});

test("an unsupported server allows passive recovery but cannot replay an uncertain project payload, even after 404", async (t) => {
    for (const projectId of ["chosen-project", null]) {
        await t.test(`frozen payload project ${JSON.stringify(projectId)}`, async () => {
            const f = fixture();
            const origin = f.draft.openAgentDraft("ada", { projectId });

            f.draft.updateAgentDraft(origin.id, "Frozen first message");
            const send = f.draft.sendAgentDraft(origin.id, {
                text: "Expanded first message",
                attachments: [{ path: "/staged/photo.png", name: "photo.png" }],
                inlineFiles: true,
            });
            const sentBody = JSON.stringify(f.requests[0]!.body);
            const payload = JSON.stringify(origin.payload);
            const requestId = origin.requestId;

            f.requests[0]!.reject(new Error("Network interrupted"));
            await assert.rejects(send, /Network interrupted/);
            // Older persisted drafts may retain project intent only in the exact attempted payload.
            const saved = JSON.parse(f.storage.get("pocket.agentDrafts.owner")!);

            delete saved[0].projectId;
            f.storage.set("pocket.agentDrafts.owner", JSON.stringify(saved));
            const reloaded = fixture(f.storage, { privateAgents: 4 });

            reloaded.draft.selectAgentDraft(origin.id);
            const recoveredDraft = reloaded.draft.selectedAgentDraft();
            const check = reloaded.draft.recoverAgentDraft(origin.id);

            assert.equal(reloaded.requests[0]!.body, undefined);
            assert.equal(
                reloaded.requests[0]!.path,
                `pip/agents/ada/submit?requestId=${requestId}`,
            );
            reloaded.requests[0]!.reject(
                Object.assign(new Error("Not accepted yet"), { status: 404 }),
            );
            assert.equal(await check, null);
            const allocations = reloaded.allocations();
            const blocked = reloaded.draft.sendAgentDraft(origin.id, { text: "Different message" });

            assert.equal(reloaded.requests.length, 1, "404 never permits an unsupported POST");
            await assert.rejects(blocked, (error: Error) => {
                assertBackendUpdate(error.message);
                assert.match(error.message, /earlier|previous/i);
                assert.match(error.message, /uncertain|may already be accepted/i);

                return true;
            });
            assertBackendUpdate(recoveredDraft.error);
            assert.match(recoveredDraft.error, /uncertain|may already be accepted/i);
            assert.equal(reloaded.allocations(), allocations);
            assert.equal(recoveredDraft.requestId, requestId);
            assert.equal(JSON.stringify(recoveredDraft.payload), payload);
            reloaded.draft.updateAgentDraft(origin.id, "Cannot alter uncertain input");
            assert.equal(recoveredDraft.text, "Frozen first message");
            reloaded.store.state.server.agentDraftProjects = 1;
            await Promise.resolve();
            assert.equal(reloaded.requests.length, 1, "upgrade never automatically replays input");
            // Later local metadata must not rebind the already-attempted request after upgrade.
            recoveredDraft.projectId = "different-later-project";
            const retry = reloaded.draft.sendAgentDraft(origin.id, {
                text: "Different message",
                attachments: [],
                inlineFiles: false,
            });

            assert.equal(JSON.stringify(reloaded.requests[1]!.body), sentBody);
            reloaded.requests[1]!.resolve(receipt(107));
            await retry;
            assert.equal(reloaded.navigations.at(-1), 107);
        });
    }
});

test("a cached capability plus native unknown-setting 400 explains backend mismatch without stripping or replaying project intent", async (t) => {
    for (const uncertain of [false, true]) {
        await t.test(
            uncertain ? "earlier acceptance uncertain" : "fresh definite refusal",
            async () => {
                const f = fixture();
                const origin = f.draft.openAgentDraft("ada", { projectId: "chosen-project" });

                f.draft.updateAgentDraft(origin.id, "First message");
                let send = f.draft.sendAgentDraft(origin.id);
                const original = JSON.stringify(f.requests[0]!.body);
                const requestId = origin.requestId;

                if (uncertain) {
                    f.requests[0]!.reject(new Error("Network interrupted"));
                    await assert.rejects(send, /Network interrupted/);
                    send = f.draft.sendAgentDraft(origin.id);
                }

                f.requests
                    .at(-1)!
                    .reject(
                        Object.assign(new Error("Unknown private agent setting"), { status: 400 }),
                    );
                await assert.rejects(send, (error: Error) => {
                    assertBackendUpdate(error.message);

                    return true;
                });
                assertBackendUpdate(origin.error);
                assert.equal(origin.projectId, "chosen-project");
                assert.equal(f.requests.length, uncertain ? 2 : 1, "no automatic strip-and-retry");
                f.draft.updateAgentDraft(origin.id, "Corrected first message");

                if (uncertain) {
                    assert.match(origin.error, /uncertain/i);
                    assert.equal(origin.requestId, requestId);
                    assert.equal(origin.text, "First message");
                } else {
                    assert.match(origin.error, /not accepted/i);
                    assert.equal(origin.requestId, undefined);
                    assert.equal(origin.payload, undefined);
                    assert.equal(origin.text, "Corrected first message");
                }

                const retry = f.draft.sendAgentDraft(origin.id);
                const retried = f.requests.at(-1)!.body as { requestId: string; projectId: string };

                assert.equal(retried.projectId, "chosen-project");

                if (uncertain) {
                    assert.equal(JSON.stringify(retried), original);
                } else {
                    assert.notEqual(retried.requestId, requestId);
                }

                f.requests.at(-1)!.resolve(receipt(108));
                await retry;
            },
        );
    }
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
