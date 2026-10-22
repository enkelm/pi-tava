// Menu composition owns integration into the native App/session menu, not identity-action callbacks.
// Use real MenuSheet, tabAgent, item and Preact/htm; stand in for the topbar's independently tested
// controls with one recognizable Memory row. Browser painting, sheets and transports are not run.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { isValidElement, type VNode } from "preact";

type Conversation = {
    id: number;
    title: string;
    kind: string;
    pipAgent?: boolean;
    pipAgentId?: string;
};
type Draft = { id: string; agentId: string; userId: string };
const identity = { agentId: "agent-a", name: "Ada" };
const fixture = {
    draft: null as Draft | null,
    opened: [] as unknown[],
    forwarded: [] as unknown[],
    store: {
        state: {
            me: { id: "owner", role: "owner" },
            conversationId: null as number | null,
            view: {
                conversation: null as Conversation | null,
                agent: { cwd: "/work/project", instructions: "" },
                subagents: [],
                artifacts: [],
                schedules: [],
            },
            server: { privateAgents: 4 },
            namedAgents: [identity],
            sessions: [],
            sheet: { type: "menu" },
        },
        subscribe() {},
    },
};

Object.assign(globalThis, {
    agentMenuFixture: fixture,
    document: new EventTarget(),
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
});

const storeSource = `
    const fixture = globalThis.agentMenuFixture;
    export const store = fixture.store;
    export const openSheet = sheet => fixture.opened.push(sheet);
    export const canSteer = () => store.state.me?.role === "owner";
    export const canToggleTurns = () => false;
    export const collab = () => false;
    export const handoffsAvailable = () => false;
    export const filesShown = () => false;
    export const actions = {};
    export const api = async () => ({});
    export const attempt = action => action();
    export const closeSheet = () => {};
    export const navigate = () => {};
    export const notify = () => {};
    export const setUnread = () => {};
`;
const uiUrl = new URL("../web/ui.js", import.meta.url).href;
const sources: Record<string, string> = {
    "store.js": storeSource,
    "browser.js": `export const browserAvailable = () => false; export const displayUrl = value => value; export const setBrowserOpen = () => {};`,
    "chat.js": `export const chatUnread = () => 0;`,
    "commands.js": `export const schedulesAvailable = () => false; export const triggersOn = () => false; export const watchAvailable = () => false; export const watchPr = () => {};`,
    "extension-ui.js": `export const extensionMenuItems = () => []; export const safeMode = () => false;`,
    "diff.js": `export const useChanges = () => ({changes: null});`,
    "files-panel.js": `export const filesAvailable = () => !!globalThis.agentMenuFixture.store.state.view.conversation; export const setFilesOpen = () => {};`,
    "peeks.js": `export const peeksOn = () => false; export const togglePeeks = () => {};`,
    "model-refresh.js": `export const modelRefreshAvailable = () => false; export const refreshModels = () => {};`,
    "pip.js": `export const openPip = () => {}; export const pipAvailable = () => false; export const pipUnread = () => false;`,
    "sessions.js": `export const setArchived = () => {}; export const toSessions = () => {};`,
    "subagents.js": `export const openSubagent = () => {};`,
    "theme.js": `export const isPinned = () => false; export const togglePin = () => {};`,
    "topbar.js": `
        import {item} from ${JSON.stringify(uiUrl)};
        export function AgentMenuItems({sheet}) {
            globalThis.agentMenuFixture.forwarded.push(sheet);
            return item("Memory", () => {}, "identity-bound memory", {"data-agent-menu": "true"});
        }
    `,
    "trust.js": `export const currentTrust = () => null; export const trustAvailable = () => false;`,
    "sheets/branch.js": `export const branchAvailable = () => false;`,
    "sheets/memory.js": `export const memoryAvailable = () => true; export const memoryHint = () => "general memory"; export const useMemory = () => ({});`,
    "sheets/model.js": `export const defaultLabel = () => ""; export const defaultsKept = () => false;`,
    "sheets/pi-sessions.js": `export const piSessionsAvailable = () => false;`,
    "workspace-location.js": `export const conversationLocation = () => null;`,
    "ssh-login.js": `export const SshLogin = () => null;`,
    "named-agents.js": `export const namedAgentsAvailable = () => globalThis.agentMenuFixture.store.state.me?.role === "owner";`,
    "agent-drafts.js": `export const selectedAgentDraft = () => globalThis.agentMenuFixture.draft; export const agentDrafts = () => []; export const closeAgentDraft = () => {}; export const openAgentDraft = () => {}; export const selectAgentDraft = () => {};`,
    "gestures.js": `export const useDragToClose = () => {};`,
    "highlight.js": `export const highlight = value => value; export const langOf = () => "";`,
};
const parents = ["/web/sheets/menu.js", "/web/agent-tabs.js", "/web/ui.js"];

registerHooks({
    resolve(specifier, context, next) {
        if (!parents.some((path) => context.parentURL?.endsWith(path))) {
            return next(specifier, context);
        }

        const key = specifier.startsWith(".")
            ? new URL(specifier, context.parentURL).pathname.split("/web/")[1]
            : specifier;
        const source =
            key === "dompurify"
                ? "export default {addHook() {}};"
                : key === undefined
                  ? undefined
                  : sources[key];

        return source === undefined
            ? next(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});

const { MenuSheet } = await import(new URL("../web/sheets/menu.js", import.meta.url).href);

type Element = VNode<Record<string, unknown>>;

function elements(value: unknown): Element[] {
    if (Array.isArray(value)) {
        return value.flatMap(elements);
    }

    if (!isValidElement(value)) {
        return [];
    }

    const element = value as Element;

    if (typeof element.type === "function") {
        return elements(Reflect.apply(element.type, null, [element.props]));
    }

    return [element, ...elements(element.props.children)];
}

function text(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(text).join("");
    }

    if (isValidElement(value)) {
        return text((value as Element).props.children);
    }

    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function renderMenu(sheet?: { type: string }) {
    const frame = MenuSheet(sheet === undefined ? {} : { sheet }) as Element;
    // MenuFrame's Sheet/DOM lifecycle is unchanged and owned by native modal/browser tests.
    const content = elements(frame.props.children);
    const rows = content.filter((node) => node.props.class === "list-item");

    return {
        title: frame.props.title,
        content,
        rows,
        label: (label: string) => rows.filter((row) => text(row.props.children).startsWith(label)),
    };
}

function reset(conversation: Conversation | null, selected = conversation?.id ?? null) {
    fixture.store.state.conversationId = selected;
    fixture.store.state.view.conversation = conversation;
    fixture.store.state.me = { id: "owner", role: "owner" };
    fixture.store.state.server.privateAgents = 4;
    fixture.store.state.sheet = { type: "menu" };
    fixture.draft = null;
    fixture.opened = [];
    fixture.forwarded = [];
}

for (const draft of [false, true]) {
    test(`${draft ? "unsent draft" : "saved chat"} combines identity Memory and native App actions in one menu`, () => {
        reset(
            draft
                ? null
                : { id: 41, kind: "session", title: "Selected chat", pipAgentId: "agent-a" },
        );

        if (draft) {
            fixture.draft = { id: "draft-1", agentId: "agent-a", userId: "owner" };
        }

        const menu = renderMenu();

        assert.equal(menu.title, "Ada");
        assert.equal(fixture.forwarded.length, 1);
        assert.equal(fixture.forwarded[0], fixture.store.state.sheet);
        assert.equal(menu.label("Memory").length, 1);
        assert.equal(menu.label("Memory")[0]?.props["data-agent-menu"], "true");
        assert.equal(menu.rows[0]?.props["data-agent-menu"], "true");
        assert.equal(menu.label("PiP settings").length, 0);
        assert.equal(menu.label("Rename").length, 0, "no ordinary conversation rename");
        assert.equal(menu.label("Working directory").length, 0);
        assert.equal(menu.label("Archive").length, 0);
        assert.ok(menu.content.some((node) => text(node.props.children) === "App"));
        assert.equal(menu.label("Running now").length, 1);
        assert.equal(menu.label("Devices and access").length, 1);
        assert.equal(menu.label("Extensions").length, 1);
        assert.equal(menu.label("Settings").length, 1);
        (menu.label("Settings")[0]!.props.onClick as () => void)();
        assert.deepEqual(fixture.opened, [{ type: "settings" }]);
        assert.equal(
            menu.content.some((node) => node.props["aria-label"] === "Places"),
            !draft,
            "saved chats retain native Places; a local draft has no saved-session places",
        );
    });
}

test("a retained menu forwards its original opening rather than a newer sheet", () => {
    reset({ id: 41, kind: "session", title: "Selected chat", pipAgentId: "agent-a" });
    const opening = { type: "menu" };

    fixture.store.state.sheet = { type: "settings" };
    renderMenu(opening);
    assert.equal(fixture.forwarded.length, 1);
    assert.equal(fixture.forwarded[0], opening);
    assert.notEqual(fixture.forwarded[0], fixture.store.state.sheet);
});

for (const mode of ["ordinary", "stale-view", "unknown-identity", "other-owner-draft", "viewer"]) {
    test(`${mode} does not gain private identity controls from stale metadata`, () => {
        reset({ id: 41, kind: "session", title: "Ordinary chat" });

        if (mode === "stale-view") {
            fixture.store.state.conversationId = 42;
            Object.assign(fixture.store.state.view.conversation!, {
                pipAgentId: "agent-a",
                pipAgent: true,
            });
        } else if (mode === "unknown-identity") {
            fixture.store.state.view.conversation!.pipAgentId = "missing-agent";
        } else if (mode === "other-owner-draft") {
            reset(null);
            fixture.draft = { id: "draft-1", agentId: "agent-a", userId: "other-owner" };
        } else if (mode === "viewer") {
            fixture.store.state.me.role = "viewer";
            fixture.store.state.view.conversation!.pipAgentId = "agent-a";
        }

        const menu = renderMenu();

        assert.equal(
            menu.rows.some((row) => row.props["data-agent-menu"]),
            false,
        );
        assert.equal(menu.label("PiP settings").length, 0);
        assert.equal(menu.title, mode === "other-owner-draft" ? "Menu" : "Ordinary chat");
        assert.equal(menu.label("Memory").length, mode === "other-owner-draft" ? 0 : 1);
        assert.equal(menu.label("Settings").length, 1);

        if (mode === "ordinary") {
            assert.equal(menu.label("Rename").length, 1);
            assert.equal(menu.label("Working directory").length, 1);
            assert.equal(menu.label("Archive").length, 1);
        }
    });
}
