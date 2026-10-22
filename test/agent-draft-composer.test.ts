// Exercise the real native Composer's event callbacks and draft client without browser/dependency stand-ins
// pretending to prove DOM focus, rendering, native admission or uploaded-file persistence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Template = { strings: string[]; values: unknown[] };

function bound(template: Template, attribute: string): unknown[] {
    return template.values.filter((_, index) =>
        new RegExp(`(?:^|\\s)${attribute}=\\s*$`).test(template.strings[index]!),
    );
}

function templates(value: unknown): Template[] {
    if (Array.isArray(value)) {
        return value.flatMap(templates);
    }

    if (value && typeof value === "object" && "strings" in value && "values" in value) {
        const template = value as Template;

        return [template, ...template.values.flatMap(templates)];
    }

    return [];
}

function fixture() {
    let slots: unknown[] = [];
    const composerSlots = slots;
    const paneSlots: unknown[] = [];
    let cursor = 0;
    let next = 0;
    let savedText = "";
    const storage = new Map<string, string>([["pocket.inlineFiles", "1"]]);
    const uploads: { agentId: string; file: { name: string } }[] = [];
    const requests: { path: string; body: any; resolve: (value: unknown) => void }[] = [];
    const notices: string[] = [];
    const sheets: any[] = [];
    const store = {
        state: {
            me: { id: "owner", role: "owner" },
            server: { privateAgents: 4 },
            namedAgents: [{ agentId: "ada" }],
            agentDraft: null as any,
            conversationId: null,
            models: [] as any[],
            view: { live: { busy: false }, inbox: [] },
        },
        set(patch: object) {
            Object.assign(this.state, patch);
        },
    };
    const context: any = {
        store,
        html: (strings: string[], ...values: unknown[]) => ({ strings, values }),
        useState(initial: unknown) {
            const index = cursor++;

            if (!(index in slots)) {
                slots[index] = typeof initial === "function" ? initial() : initial;
            }

            return [
                slots[index],
                (value: unknown) => {
                    slots[index] = typeof value === "function" ? value(slots[index]) : value;
                },
            ];
        },
        useRef(value: unknown) {
            const index = cursor++;

            slots[index] ??= { current: value };

            return slots[index];
        },
        useEffect() {},
        useLayoutEffect() {},
        useDock() {},
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
        requestAnimationFrame: (callback: () => void) => callback(),
        matchMedia: () => ({ matches: false }),
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
        sessionStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        },
        uid: () => `request-${++next}`,
        URL: { createObjectURL: () => `blob:${++next}`, revokeObjectURL() {} },
        navigate: (_id: unknown, options?: any) => {
            store.state.agentDraft = options?.agentDraft ?? null;
        },
        api: (path: string, body: unknown) =>
            new Promise((resolve) => requests.push({ path, body, resolve })),
        actions: {
            uploadAgentDraft: async (agentId: string, file: { name: string }) => {
                uploads.push({ agentId, file });

                return {
                    path: `/staged/${file.name}`,
                    name: file.name,
                    mime: "image/png",
                    size: 3,
                };
            },
            upload: async (file: { name: string }) => {
                uploads.push({ agentId: "ordinary", file });

                return {
                    path: `/ordinary/${file.name}`,
                    name: file.name,
                    mime: "image/png",
                    size: 3,
                };
            },
            submit: () => {
                throw new Error("An unsaved Chat used ordinary model input");
            },
            shell: () => {
                throw new Error("An unsaved Chat used ordinary shell dispatch");
            },
        },
        attempt: async (action: () => Promise<unknown>) => action(),
        notify: (_level: string, message: string) => notices.push(message),
        openSheet: (sheet: unknown) => sheets.push(sheet),
        drafts: {
            get: () => savedText,
            revision: () => 0,
            set: (_id: unknown, text: string) => {
                savedText = text;
            },
        },
        canSteer: () => true,
        collab: () => false,
        scoped: () => false,
        typing() {},
        loadFiles() {},
        suggestFiles: () => null,
        mentionAt: () => null,
        sentHistory: () => [],
        searchHistory: () => [],
        remember() {},
        useDictation: () => ({ stop() {}, listening: false }),
        extensionInputSuggestions: async () => [],
        extensionInputCommands: () => [],
        browserAvailable: () => false,
        filesAvailable: () => false,
        memoryAvailable: () => false,
        branchAvailable: () => false,
        pipAvailable: () => false,
        trustAvailable: () => false,
        projectsAvailable: () => false,
        modelLabel: () => "Choose model",
        formatBytes: (n: number) => String(n),
        APPLE: false,
    };

    // Component children are template values. Their DOM behavior is outside this callback test's contract.
    for (const name of [
        "Avatar",
        "TypingLine",
        "MessageBox",
        "SendButton",
        "SubagentsBar",
        "TrustBar",
        "MicButton",
        "Icon",
        "Spinner",
        "Marked",
        "ExtensionSessionControls",
    ]) {
        context[name] = () => null;
    }

    const source = (name: string) =>
        readFileSync(new URL(`../web/${name}.js`, import.meta.url), "utf8")
            .replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
            .replace(/\bexport /g, "");
    const evaluate = (name: string, exports: string) =>
        Object.assign(
            context,
            runInNewContext(`(() => { ${source(name)}; return {${exports}}; })()`, context),
        );

    evaluate(
        "agent-drafts",
        "openAgentDraft, selectedAgentDraft, sendAgentDraft, updateAgentDraft, updateAgentDraftFiles, updateAgentDraftPastes, recoverAgentDraft, agentDraftSending",
    );
    evaluate(
        "commands",
        "parseCommand, parseTemplate, suggestCommands, loadTemplates, planAvailable",
    );
    evaluate("composer", "Composer");
    evaluate("agent-draft-pane", "AgentDraftPane");
    const draft = context.openAgentDraft("ada");
    let tree: Template;

    const render = () => {
        slots = paneSlots;
        cursor = 0;
        const pane = context.AgentDraftPane();
        const mount = templates(pane).find((each) => each.values.includes(context.Composer));

        assert.ok(mount, "unsaved Chat mounts the native Composer, not a text-only MessageBox");
        slots = composerSlots;
        cursor = 0;
        tree = context.Composer({
            draft: bound(mount, "draft")[0],
            onCheckDraft: bound(mount, "onCheckDraft")[0],
        });

        return tree;
    };

    const input = () => {
        render();

        return templates(tree).flatMap((each) => bound(each, "input"))[0] as any;
    };

    const enter = () => input().onKeyDown({ key: "Enter", preventDefault() {} });
    const type = (value: string) =>
        input().onInput({ currentTarget: { value, selectionStart: value.length } });

    const flush = async () => {
        for (let n = 0; n < 8; n++) {
            await Promise.resolve();
        }
    };

    return { draft, store, uploads, requests, notices, sheets, input, enter, type, flush, render };
}

test("draft native Composer stages pasted/dropped images, previews/removes files and expands long pastes on first Send", async () => {
    const f = fixture();
    const file = { name: "paste.png", type: "image/png", size: 3 };
    let prevented = false;

    f.input().onPaste({
        clipboardData: { files: [file] },
        preventDefault() {
            prevented = true;
        },
    });
    await f.flush();
    assert.equal(prevented, true);
    assert.equal(f.uploads[0]?.agentId, "ada", "upload is identity-bound, never home/current Chat");
    assert.equal(f.requests.length, 0, "upload does not submit or reserve a conversation");
    const chip = templates(f.render()).find((each) =>
        bound(each, "aria-label").includes("Remove paste.png"),
    )!;

    assert.ok(chip, "completed image has native removal control");
    assert.ok(
        templates(chip).some((each) => each.strings.join("").includes("chip-thumb")),
        "Composer includes the native image preview",
    );
    (bound(chip, "onClick")[0] as () => void)();
    f.type("Review @notes.txt ");
    const long = Array.from({ length: 25 }, (_, n) => `line ${n}`).join("\n");
    const before = f.draft.text;

    f.input().onPaste({
        clipboardData: { files: [], getData: () => long },
        currentTarget: { selectionStart: before.length, selectionEnd: before.length },
        preventDefault() {},
    });
    assert.match(f.draft.text, /\[Pasted text #1/);
    const drop = templates(f.render()).flatMap((each) => bound(each, "onDrop"))[0] as (
        event: unknown,
    ) => void;

    drop({ dataTransfer: { files: [{ ...file, name: "drop.png" }] }, preventDefault() {} });
    await f.flush();
    f.enter();
    await f.flush();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.path, "pip/agents/ada/submit");
    assert.equal(
        f.requests[0]?.body.text,
        before + long,
        "native paste expansion, not the folded placeholder, is sent",
    );
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0]?.body.attachments)), [
        { path: "/staged/drop.png", name: "drop.png", mime: "image/png", size: 3 },
    ]);
    assert.equal(f.requests[0]?.body.inlineFiles, true);
    f.requests[0]!.resolve({ id: 101, agentId: "ada", submissionId: 7 });
    await f.flush();
});

test("draft model/thinking arguments configure their captured identity, never the newly selected Chat", async () => {
    const f = fixture();

    f.store.state.models.push({
        provider: "faux",
        id: "reasoner",
        name: "Reasoner",
        levels: ["off", "high"],
    });
    f.type("/model reasoner");
    f.enter();
    await f.flush();
    assert.equal(f.requests[0]?.path, "pip/agents/ada/configure");
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0]?.body)), {
        model: { provider: "faux", modelId: "reasoner" },
    });
    f.requests[0]!.resolve({});
    await f.flush();
    f.type("/thinking high");
    f.enter();
    await f.flush();
    assert.equal(f.requests[1]?.path, "pip/agents/ada");
    assert.equal(f.requests[1]?.body, undefined);
    f.store.state.agentDraft = { id: "newly-selected", agentId: "bea" };
    f.requests[1]!.resolve({ model: { provider: "faux", modelId: "reasoner" } });
    await f.flush();
    assert.equal(f.requests[2]?.path, "pip/agents/ada/configure");
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests[2]?.body)), { thinkingLevel: "high" });
    f.requests[2]!.resolve({});
    await f.flush();
    assert.ok(
        f.requests.every((request) => !request.path.endsWith("/submit")),
        "commands never become model input",
    );
});

test("draft commands use native dispatch: shell/session effects are refused, Model stays identity-bound", async () => {
    const f = fixture();

    for (const command of ["!git status", "!!echo local", "/compact", "/new", "/plan"]) {
        f.type(command);
        f.enter();
        await f.flush();
        assert.equal(f.requests.length, 0, `${command} must not silently become model input`);
        assert.match(f.notices.at(-1)!, /saved Chat/);
    }

    f.type("/model");
    f.enter();
    await f.flush();
    assert.equal(f.sheets.at(-1)?.type, "model");
    assert.equal(f.sheets.at(-1)?.agentId, "ada");
    assert.equal(f.requests.length, 0);
});
