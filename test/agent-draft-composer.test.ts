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

function fixture({
    projectId,
    server = { privateAgents: 4, agentDraftProjects: 1 },
}: {
    projectId?: string | null;
    server?: { privateAgents: number; agentDraftProjects?: number };
} = {}) {
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
    const navigations: unknown[] = [];
    const sheets: any[] = [];
    const store = {
        state: {
            me: { id: "owner", role: "owner" },
            server,
            namedAgents: [{ agentId: "ada" }] as any[],
            agentDraft: null as any,
            conversationId: null as number | null,
            models: [] as any[],
            view: { live: { busy: false }, inbox: [], agent: null } as any,
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
        navigate: (id: unknown, options?: any) => {
            navigations.push(id ?? options?.agentDraft?.id);
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
        attempt: async (action: () => Promise<unknown>) => {
            try {
                return await action();
            } catch (error) {
                notices.push((error as Error).message);

                return undefined;
            }
        },
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
        // Execute the native label formatter, not a stub that hides model binding mistakes.
        modelLabel: runInNewContext(
            readFileSync(new URL("../web/ui.js", import.meta.url), "utf8")
                .match(/export function modelLabel\(agent\) \{[\s\S]*?\n\}/)![0]
                .replace("export ", "") + "; modelLabel;",
        ),
        formatBytes: (n: number) => String(n),
        APPLE: false,
    };

    context.savedDrafts = context.drafts;

    // Component children are template values. Their DOM behavior is outside this callback test's contract.
    for (const name of [
        "Avatar",
        "NamedAgentAvatar",
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
    const draft = context.openAgentDraft("ada", { projectId });
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

    const renderCaptured = () => {
        slots = composerSlots;
        cursor = 0;

        return context.Composer({ draft });
    };

    return {
        draft,
        store,
        uploads,
        requests,
        notices,
        navigations,
        sheets,
        input,
        enter,
        type,
        flush,
        render,
        renderCaptured,
        openDraft: context.openAgentDraft,
    };
}

function modelChip(f: ReturnType<typeof fixture>, captured = false) {
    const chip = templates(captured ? f.renderCaptured() : f.render()).find((each) =>
        each.strings.some((part) => part.includes('data-part="model-chip"')),
    );

    assert.ok(chip, "the actual Composer model control is visible");
    const start = chip.strings.findIndex((part) => part.includes('data-part="model-chip"'));
    const click = chip.values.find(
        (_, index) => index >= start && /onClick=\s*$/.test(chip.strings[index]!),
    ) as () => void;

    return {
        click,
        label: bound(chip, "aria-label")[0] as string,
        classes: bound(chip, "class").find((value) =>
            String(value).startsWith("model-chip"),
        ) as string,
        chip,
    };
}

test("draft Composer binds model and thinking to the selected identity catalogue, not prior room or global defaults", () => {
    const f = fixture();
    const a = {
        model: { provider: "test", modelId: "a" },
        modelName: "Claude Identity A",
        reasoning: true,
        thinkingLevel: "high",
        available: true,
    };
    const b = {
        model: { provider: "test", modelId: "b" },
        modelName: "Prior room B",
        reasoning: true,
        thinkingLevel: "low",
        available: true,
    };

    f.store.state.view.agent = b;
    f.store.state.models.push({ provider: "test", id: "default", name: "Global default" });
    f.store.state.namedAgents = [
        { agentId: "ada", modelInfo: a },
        { agentId: "bea", modelInfo: b },
    ];
    assert.equal(
        modelChip(f).label,
        "Agent model: Claude Identity A, thinking high (shared across chats)",
    );
    assert.ok(
        templates(modelChip(f).chip)
            .flatMap((each) => each.values)
            .includes("identity a"),
    );
    const capturedPicker = modelChip(f).click;

    f.openDraft("bea");
    capturedPicker();
    assert.equal(
        f.sheets.at(-1).agentId,
        "ada",
        "a captured model control retains its original identity",
    );
    modelChip(f).click();
    assert.equal(f.sheets.at(-1).agentId, "bea");
    assert.equal(
        modelChip(f).label,
        "Agent model: Prior room B, thinking low (shared across chats)",
    );
    f.store.state.namedAgents[1].modelInfo = {
        ...b,
        modelName: "Updated identity B",
        thinkingLevel: "medium",
    };
    assert.equal(
        modelChip(f).label,
        "Agent model: Updated identity B, thinking medium (shared across chats)",
    );
    f.store.state.namedAgents[1].modelInfo = { ...b, available: false };
    assert.match(modelChip(f).classes, /warn/);
    assert.match(modelChip(f).label, /Prior room B.*thinking low.*unavailable/);
    f.store.state.namedAgents[1].modelInfo = {
        ...b,
        modelName: undefined,
        reasoning: undefined,
        available: false,
    };
    assert.match(modelChip(f).label, /Agent model: b, thinking low, unavailable/);
    assert.equal(f.requests.length, 0, "model display needs no second fetch/cache or submission");
});

test("draft model display is honest about unknown projection and never exposes stale private state after source/access changes", () => {
    const f = fixture();

    f.store.state.view.agent = {
        model: { provider: "test", modelId: "wrong" },
        modelName: "PRIVATE PRIOR MODEL",
    };
    assert.match(modelChip(f).label, /Agent model unavailable/);
    f.store.state.namedAgents[0].modelInfo = {};
    assert.match(modelChip(f).label, /Agent model unavailable/);
    f.store.state.namedAgents = undefined as any;
    assert.match(modelChip(f, true).label, /Loading agent model/);
    f.store.state.namedAgents = [{ agentId: "ada" }];
    f.store.state.namedAgents[0].modelInfo = {
        model: null,
        available: false,
        thinkingLevel: "off",
    };
    assert.match(modelChip(f).label, /No model/);
    f.store.state.namedAgents[0].modelInfo = {
        model: { provider: "test", modelId: "private" },
        modelName: "PRIVATE IDENTITY MODEL",
        available: true,
    };

    for (const change of [
        () => {
            f.store.state.me.role = "guest";
        },
        () => {
            f.store.state.me.id = "another-owner";
        },
        () => {
            f.store.state.server.privateAgents = 3;
        },
        () => {
            f.store.state.namedAgents = [];
        },
        () => {
            f.store.state.agentDraft = { id: "different-source", agentId: "bea" };
        },
    ]) {
        f.store.state.me = { id: "owner", role: "owner" };
        f.store.state.server.privateAgents = 4;
        f.store.state.agentDraft = { id: f.draft.id, agentId: "ada" };
        f.store.state.namedAgents = [
            {
                agentId: "ada",
                modelInfo: {
                    model: { provider: "test", modelId: "private" },
                    modelName: "PRIVATE IDENTITY MODEL",
                    available: true,
                },
            },
        ];
        change();
        assert.match(modelChip(f, true).label, /Agent model unavailable/);
        assert.doesNotMatch(modelChip(f, true).label, /PRIVATE|No model/);
    }
});

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
    assert.equal(
        f.requests[0]?.body.model,
        undefined,
        "first Send leaves model selection server-authoritative",
    );
    assert.equal(f.requests[0]?.body.thinkingLevel, undefined);
    f.requests[0]!.resolve({ id: 101, agentId: "ada", submissionId: 7 });
    await f.flush();
});

test("project first Send on an older backend renders an explanation and keeps native text, pasted content and staged files editable", async () => {
    const f = fixture({ projectId: "chosen-project", server: { privateAgents: 4 } });

    f.type("Review @notes.txt ");
    const prefix = f.draft.text;
    const long = Array.from({ length: 25 }, (_, n) => `line ${n}`).join("\n");

    f.input().onPaste({
        clipboardData: { files: [], getData: () => long },
        currentTarget: { selectionStart: prefix.length, selectionEnd: prefix.length },
        preventDefault() {},
    });
    f.input().onPaste({
        clipboardData: { files: [{ name: "paste.png", type: "image/png", size: 3 }] },
        preventDefault() {},
    });
    await f.flush();
    assert.equal(f.uploads[0]?.agentId, "ada");
    assert.match(f.draft.text, /\[Pasted text #1/);
    const text = f.draft.text;
    const files = JSON.stringify(f.draft.files);
    const pastes = JSON.stringify(f.draft.pastes);
    const navigations = f.navigations.length;

    f.enter();
    await f.flush();
    assert.equal(
        f.requests.length,
        0,
        "failed Send cannot fall through to configure or saved Chat input",
    );
    const alert = templates(f.render()).find((each) =>
        each.strings.some((part) => part.includes('role="alert"')),
    );

    assert.ok(alert, "the native Composer renders its draft failure as an alert");
    assert.ok(alert.values.includes(f.draft.error));
    assert.match(f.draft.error, /server|backend/i);
    assert.match(f.draft.error, /updat/i);
    assert.match(f.draft.error, /restart/i);
    assert.match(f.draft.error, /reload/i);
    assert.equal(f.notices.at(-1), f.draft.error);
    assert.equal(f.input().value, text);
    assert.equal(f.input().readOnly, false);
    assert.equal(f.draft.requestId, undefined);
    assert.equal(f.draft.payload, undefined);
    assert.equal(f.draft.projectId, "chosen-project");
    assert.equal(JSON.stringify(f.draft.files), files);
    assert.equal(JSON.stringify(f.draft.pastes), pastes);
    const file = templates(f.render()).find((each) =>
        bound(each, "aria-label").includes("Remove paste.png"),
    );

    assert.ok(file, "the staged file remains in the Composer");
    assert.equal(bound(file, "disabled")[0], false);
    assert.equal(f.navigations.length, navigations);
    assert.equal(f.store.state.conversationId, null);
    assert.equal(f.sheets.length, 0);
    f.type(`${text} revised`);
    assert.equal(f.draft.text, `${text} revised`);
    f.store.state.server.agentDraftProjects = 1;
    f.render();
    await f.flush();
    assert.equal(
        f.requests.length,
        0,
        "capability arrival does not dispatch the retained composition",
    );
    f.enter();
    await f.flush();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.path, "pip/agents/ada/submit");
    assert.equal(f.requests[0]!.body.projectId, "chosen-project");
    assert.equal(f.requests[0]!.body.text, `${prefix}${long} revised`);
    assert.equal(f.requests[0]!.body.attachments[0].path, "/staged/paste.png");
    assert.equal(f.requests[0]!.body.inlineFiles, true);
    assert.equal(f.requests[0]!.body.model, undefined);
    f.requests[0]!.resolve({ id: 109, agentId: "ada", submissionId: 7 });
    await f.flush();
    assert.equal(f.navigations.at(-1), 109);
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
