// HTTP and room delivery own privacy/routing: named conversations must never replace the quick PiP popup.
// Scripted provider and memory HTTP keep these checks offline and away from live data.
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createHandler } from "../src/server/http.ts";
import {
    type App,
    cleanUp,
    echo,
    fakeTab,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

let app: App;
let handler: ReturnType<typeof createHandler>;
let release: (() => void) | undefined;
let hold: Promise<void> | undefined;
let named: ConversationId;

const route: FauxResponseStep = async (...args) => {
    if (hold !== undefined) {
        await hold;
    }

    return typeof echo === "function" ? echo(...args) : echo;
};

before(async () => {
    app = await openApp(scriptedModel(route));
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
});
after(async () => {
    release?.();
    await app?.close();
    cleanUp();
});

async function request(path: string, body?: unknown, token = app.config.ownerToken) {
    const input = new IncomingMessage(new Socket());
    const output = new ServerResponse(input);
    let text = "";

    input.url = `/api/${path}`;
    input.method = body === undefined ? "GET" : "POST";
    input.headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    output.end = (chunk?: unknown) => {
        text = String(chunk ?? "");

        return output;
    };

    const handled = handler(input, output);

    if (body !== undefined) {
        input.push(Buffer.from(JSON.stringify(body)));
    }

    input.push(null);
    await handled;

    return new Response(text, {
        status: output.statusCode,
        headers: { "cache-control": String(output.getHeader("cache-control") ?? "") },
    });
}

test("named-agent HTTP and room events are owner-private and use an ordinary conversation view", async () => {
    const initial = await request("pip/agents");

    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("cache-control"), "no-store");
    assert.equal(app.pip.idOf(owner(app).id), undefined, "listing does not create quick PiP");
    const { blueprint } = await initial.json();
    const { id: projectId } = await app.projects.create(owner(app), {
        requestId: "routing-project",
        name: "Owner's remit",
        cwd: work,
    });
    const created = await request("pip/agents", {
        requestId: "routing-atlas",
        name: "Atlas",
        projectId,
        instructions: blueprint.instructions,
        focus: "Owner-private navigation remit",
    });

    assert.equal(created.status, 200);
    named = (await created.json()).id as ConversationId;
    const detail = await request(`c/${named}/private-agent`);

    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get("cache-control"), "no-store");
    const record = await detail.json();

    assert.equal(record.focus, "Owner-private navigation remit");
    assert.equal(record.projectId, projectId);
    assert.deepEqual(record.project, { id: projectId, available: true, name: "Owner's remit" });
    assert.equal(app.sessionMeta(named)?.projectId, undefined);
    const ownTab = fakeTab(named, owner(app));

    await app.attach(ownTab.client);

    try {
        await until(() => ownTab.field("conversation") !== undefined, "named full-pane view");
        assert.equal((ownTab.field("conversation") as { pipAgent: boolean }).pipAgent, true);
        assert.equal(
            (ownTab.field("conversation") as { pipAgentId: string }).pipAgentId,
            record.agentId,
        );
        assert.match(JSON.stringify(ownTab.field("entries")), /Welcome! I'm your private PiP/);
        assert.ok(JSON.stringify(ownTab.last("namedAgents")).includes("Atlas"));
        assert.ok(!JSON.stringify(ownTab.last("sessions")).includes("Atlas"));

        for (const role of ["guest", "viewer"] as const) {
            const { user, token } = app.config.addUser(role, role);
            const tab = fakeTab(undefined, user);

            assert.equal((await request("pip/agents", undefined, token)).status, 403);
            assert.equal(
                (await request("pip/agents", { name: "intruder", requestId: role }, token)).status,
                403,
            );
            assert.equal((await request(`c/${named}/private-agent`, undefined, token)).status, 404);
            assert.equal(
                (
                    await request(
                        `c/${named}/private-agent`,
                        { expectedRevision: 1, focus: "leak" },
                        token,
                    )
                ).status,
                404,
            );
            await app.attach(tab.client);

            try {
                assert.deepEqual(tab.last("namedAgents"), []);
                assert.ok(!JSON.stringify(tab.events).includes("Atlas"));
                assert.equal(app.canSee(user, named), false);
            } finally {
                app.detach(tab.client);
            }
        }
    } finally {
        app.detach(ownTab.client);
    }
});

test("named model choices stay independent of quick PiP/defaults and reject busy edits", async () => {
    const person = owner(app);
    const generic = await app.pip.ensure(person);
    const defaults = app.config.lastModel;

    await app.commands.configure(named, person, { model: { provider: "faux", modelId: "faux-2" } });
    assert.equal((await app.agentState(named))?.model?.modelId, "faux-2");
    assert.equal((await app.agentState(generic))?.model?.modelId, "faux-1");
    assert.deepEqual(app.config.lastModel, defaults);
    assert.equal(app.pip.idOf(person.id), generic);
    assert.equal(await app.pip.ensure(person), generic);
    assert.equal((await app.pip.settings(person)).chats.id, Number(generic));
    await assert.rejects(app.commands.configure(named, person, { cwd: "/tmp" }), /focus.*remit/);
    await assert.rejects(app.commands.setInstructions(named, person, "unversioned"), /revisioned/);
    await assert.rejects(
        app.commands.updateSession(named, person, { title: "bypass" }),
        /PiP settings/,
    );
    hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    const answer = say(app, named, "a held response");

    try {
        await until(() => app.isBusy(named), "named response starts");
        await assert.rejects(
            app.commands.configure(named, person, {
                model: { provider: "faux", modelId: "faux-1" },
            }),
            /working/,
        );
    } finally {
        hold = undefined;
        release?.();
        release = undefined;
        await answer;
    }
});

test("legacy named sends cannot bypass native source admission or private-sibling isolation", async () => {
    const generic = await app.pip.ensure(owner(app));
    const session = await newSession(app);

    await app.pip.read(named, Number(session));
    await assert.rejects(
        app.pip.send(
            named,
            Number(session),
            "Observe this exact thread only.",
            false,
            "named-send",
        ),
        /source-authority and origin-pinned adapter/,
    );
    const sent = (await app.transcripts.allEntries(session, true)).filter(
        (entry) => entry.kind === "user",
    );

    assert.equal(sent.length, 0, "unadapted legacy API cannot dispatch a named message");
    const sibling = await app.pip.agents.create(owner(app), {
        name: "Private sibling",
        requestId: "private-sibling",
    });

    await assert.rejects(
        app.pip.send(
            named,
            sibling.id,
            "Not an authorized execution recipient",
            false,
            "hidden-send",
        ),
        /no session/,
    );
    const costs = app.spend.summary(owner(app)).sessions;

    assert.ok(costs.some((row) => row.id === Number(named) && row.title === "Atlas"));
    assert.ok(costs.some((row) => row.id === Number(generic) && row.title === "PiP"));
});

test("completion notices open the exact named conversation but keep generic PiP in its popup", async () => {
    const notices: { id: number; url?: string }[] = [];
    const original = app.alerts.push;

    app.alerts.push = async (_user, id, _kind, message) => {
        notices.push({ id: Number(id), url: message.url });
    };

    try {
        const generic = await app.pip.ensure(owner(app));

        await say(app, named, "named notice");
        await say(app, generic, "quick notice");
        await until(
            () =>
                notices.some((notice) => notice.id === Number(named)) &&
                notices.some((notice) => notice.id === Number(generic)),
            "both completion notices",
        );
        assert.equal(notices.find((notice) => notice.id === Number(named))?.url, `/s/${named}`);
        assert.equal(notices.find((notice) => notice.id === Number(generic))?.url, "/?pip=1");
    } finally {
        app.alerts.push = original;
    }
});
