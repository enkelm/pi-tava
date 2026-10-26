// The real placement action and Move sheet must resolve private saved Chats without publishing
// them into the ordinary session catalogue. Backend project tests own durable authorization.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { h } from "preact";

const template = (await import(import.meta.resolve("htm"))).default.bind(h);

type Props = Record<string, any>;
const fixture = {
    state: {} as Props,
    calls: [] as Props[],
    html: template,
};
const key = "sessionPlacementFixture";
const previous = Object.getOwnPropertyDescriptor(globalThis, key);

Object.defineProperty(globalThis, key, { configurable: true, value: fixture });
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const owner = /\/web\/(?:session-moves|sheets\/session-move)\.js$/.test(
            context.parentURL ?? "",
        );
        const source = !owner
            ? undefined
            : specifier.endsWith("/store.js")
              ? `const f=globalThis.sessionPlacementFixture;
                export const store={get state(){return f.state}},projectsAvailable=()=>!!f.state.server.projects,handoffsAvailable=()=>true,notify=()=>{},closeSheet=()=>{};
                export const actions={updateSession:async(id,patch)=>f.calls.push({kind:'thread',id,patch}),updateWorkItem:async(id,patch)=>f.calls.push({kind:'work',id,patch})};`
              : specifier === "preact/hooks"
                ? `export const useState=value=>[value,()=>{}],useRef=value=>({current:value}),useLayoutEffect=()=>{};`
                : specifier.endsWith("/ui.js")
                  ? `export const html=globalThis.sessionPlacementFixture.html,Sheet=()=>null;`
                  : undefined;

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
const { moveSessions } = await import(new URL("../web/session-moves.js", import.meta.url).href);
const { SessionMoveSheet } = await import(
    new URL("../web/sheets/session-move.js", import.meta.url).href
);

after(() => {
    hooks.deregister();

    if (previous) {
        Object.defineProperty(globalThis, key, previous);
    } else {
        Reflect.deleteProperty(globalThis, key);
    }
});

function setup() {
    fixture.calls = [];
    fixture.state = {
        me: { id: "owner", role: "owner" },
        server: { projects: 1, privateAgents: 4 },
        sessions: [
            { id: 1, workItemId: "work", projectId: "build" },
            { id: 2, workItemId: "work", projectId: "build" },
        ],
        namedAgents: [
            { agentId: "nora", chats: [{ id: 10, title: "Private Chat", projectId: "build" }] },
        ],
        projects: [
            { id: "build", name: "Build" },
            { id: "other", name: "Other" },
        ],
        projectsLoaded: true,
    };
}

function nodes(value: any): Props[] {
    if (Array.isArray(value)) {
        return value.flatMap(nodes);
    }

    return value?.props ? [value, ...nodes(value.props.children)] : [];
}

test("private named Chat placement recognizes no-op drops and the Move sheet's current project", async () => {
    setup();
    const sessions = fixture.state.sessions;
    const result = await moveSessions([10], { projectId: "build", label: "Build" });
    const sheet = SessionMoveSheet({ ids: [10] });

    assert.deepEqual(
        fixture.calls,
        [],
        "dropping a private Chat onto its own project sends nothing",
    );
    assert.deepEqual(result, { moved: [], failed: [], error: "" });
    assert.equal(nodes(sheet).find((node) => node.type === "select")?.props.value, "build");
    assert.equal(
        fixture.state.sessions,
        sessions,
        "private Chats never enter the shared catalogue",
    );
    assert.deepEqual(
        sessions.map((session: Props) => session.id),
        [1, 2],
    );
});

test("private Chat moves use the ordinary exact-session route alongside deduplicated Work Items", async () => {
    setup();
    const result = await moveSessions([10, 1, 2], { projectId: "other", label: "Other" });

    assert.deepEqual(fixture.calls, [
        { kind: "thread", id: 10, patch: { projectId: "other" } },
        { kind: "work", id: 1, patch: { projectId: "other" } },
    ]);
    assert.deepEqual(result.moved, [10, 1, 2]);
    assert.deepEqual(result.failed, []);
    fixture.calls = [];
    await moveSessions([10], { projectId: null, label: "No project" });
    assert.deepEqual(fixture.calls, [{ kind: "thread", id: 10, patch: { projectId: null } }]);
    fixture.calls = [];
    fixture.state.me.role = "guest";
    const denied = await moveSessions([10], { projectId: "other", label: "Other" });

    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(denied.failed, [10]);
});
