// The extension loader on its own, with a real registry: a version that fails part way through installing, a load that
// never finishes, and who hears about it all.
import { cleanUp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

after(cleanUp);

/** What the test modules reach on `globalThis`: gates to hold their import, and counts of their cleanups. */
const shared = globalThis as unknown as {
    gates?: Record<string, Promise<void>>;
    cleaned?: Record<string, number>;
};

shared.gates = {};
shared.cleaned = {};

let folders = 0;

/** A loader on fresh folders, with every drop-in on. */
function setUp(loadLimitMs?: number, changed?: () => void) {
    const directory = join(root, `loader-${++folders}`);
    const builtIn = join(directory, "built-in");
    const dropIn = join(directory, "drop-ins");

    mkdirSync(builtIn, { recursive: true });
    mkdirSync(dropIn, { recursive: true });

    const registry = createRegistry();
    const choices = new Map<string, boolean>();
    const notices: { to: string; level: string; message: string }[] = [];
    const host = {
        notice: (level: string, message: string) =>
            notices.push({ to: "everyone", level, message }),
    } as unknown as PocketHost;
    const webs = new ExtensionWebs(changed === undefined ? {} : { changed });
    const loader = new ExtensionLoader(
        registry,
        host,
        { builtIn, dropIn },
        (file) => choices.get(file) ?? true,
        {
            webs,
            notify: (level, message) => notices.push({ to: "owner", level, message }),
            ...(loadLimitMs === undefined ? {} : { loadLimitMs }),
        },
    );
    const installed = () =>
        registry
            .snapshot()
            .installed()
            .filter((extension) => extension.name.startsWith("t-"))
            .map((extension) => `${extension.name}@${(extension as { v?: number }).v}`);

    return { builtIn, dropIn, choices, notices, webs, loader, installed };
}

/** A module that adds a route answering its version, and one extension. */
const gated = (name: string, version: number) => `/** ${name}, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	return { name: "t-${name}", v: ${version} };
};
`;

/** A gate the test opens by hand. */
function gate(name: string): () => void {
    let open!: () => void;

    shared.gates![name] = new Promise<void>((resolve) => (open = resolve));

    return open;
}

/** A small workflow whose optional handoff appears only after its destination occurs in history. */
function workflowDefinition(
    module: string,
    destination = "review",
    prompt = "Registered playbook",
) {
    return {
        id: `${module}:flow`,
        profiles: [
            {
                id: `${module}:write`,
                name: "Writer",
                description: "Implement the request.",
                prompt,
                title: "Implementation",
                starter: true,
            },
            {
                id: `${module}:${destination}`,
                name: "Next agent",
                description: "Continue the requested work.",
                prompt: "Continue the work.",
                title: "Next stage",
            },
        ],
        transitions: [
            {
                from: `${module}:write`,
                to: `${module}:${destination}`,
                relationship: "same-work" as const,
                historyAny: [`${module}:${destination}`],
                currentDiff: true,
            },
        ],
    };
}

const workflowModule = (definition: unknown, body = "") => `/** Declarative workflow fixture. */
export default async (_host, web) => {
    const definition = ${JSON.stringify(definition)};
    web.workflow(definition);
    ${body}
};
`;

const owner = { role: "owner" as const };

const answer = (webs: ExtensionWebs, module: string) => {
    const found = webs.match(module, "GET", ["v"], owner);

    return found !== undefined && "route" in found
        ? (found.route.handle({} as never) as { v?: unknown })
        : undefined;
};

test("a version that fails part way through installing leaves the version before whole", async () => {
    const { dropIn, loader, webs, installed } = setUp();
    const module = (version: number, extra: string) => `/** Halves, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	web.onDispose(() => { globalThis.cleaned.halves = (globalThis.cleaned.halves ?? 0) + 1; });
	return [{ name: "t-halves-a", v: ${version} }, ${extra}];
};
`;

    writeFileSync(join(dropIn, "halves.ts"), module(1, `{ name: "t-halves-b", v: 1 }`));
    await loader.reload("halves.ts");
    assert.deepEqual(installed(), ["t-halves-a@1", "t-halves-b@1"]);

    // The second extension of version 2 is refused by the registry (a bad section key), after the first installed.
    writeFileSync(
        join(dropIn, "halves.ts"),
        module(2, `{ name: "t-halves-c", v: 2, sections: [{ key: "BAD" }] }`),
    );
    await assert.rejects(loader.reload("halves.ts"), /Section key "BAD"/);
    assert.deepEqual(installed(), ["t-halves-a@1", "t-halves-b@1"]);
    assert.deepEqual(answer(webs, "halves"), { v: 1 });
    // Version 2's own cleanup ran; version 1's did not.
    assert.equal(shared.cleaned!.halves, 1);
});

test("what the loader says about modules goes to the owner alone", async () => {
    const { dropIn, loader, notices } = setUp();

    writeFileSync(join(dropIn, "tell.ts"), gated("tell", 1));
    await loader.reload("tell.ts");
    loader.watch();

    try {
        // An edit that fails to load names what failed: words for the owner, as they can quote a secret.
        writeFileSync(
            join(dropIn, "tell.ts"),
            `/** Tell. */\nexport default () => { throw new Error("provider said sk-not-for-guests"); };\n`,
        );
        await until(
            () => notices.some((each) => /sk-not-for-guests/.test(each.message)),
            "the failure is told",
        );
        assert.ok(notices.every((each) => each.to === "owner"));
    } finally {
        await loader.close();
    }
});

test("a load that never finishes fails after the limit, and installs nothing if it finishes later", async () => {
    const { dropIn, loader, webs } = setUp(200);

    writeFileSync(
        join(dropIn, "stuck.ts"),
        `/** Stuck: waits for ever while it sets up. */
export default async (_host, web) => {
	web.route("GET", "v", () => ({ v: "stuck" }));
	await globalThis.gates.stuck;
};
`,
    );
    const open = gate("stuck");

    await assert.rejects(
        loader.reload("stuck.ts"),
        /did not finish loading in time \(0\.2 s at most/,
    );
    open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(answer(webs, "stuck"), undefined);
});

test("a new version with other tools tells the tabs, though its browser module stayed the same", async () => {
    let told = 0;
    const { dropIn, loader } = setUp(undefined, () => told++);
    const module = (tool: string) => `/** Tooled. */
export default (_host, web) => {
	web.client("tooled.js", { access: "view" });
	return { name: "t-tooled", tools: [{ name: "${tool}", description: "", parameters: { type: "object" }, execute: () => {} }] };
};
`;

    writeFileSync(join(dropIn, "tooled.js"), "export default () => {};\n");
    writeFileSync(join(dropIn, "tooled.ts"), module("tooled_a"));
    await loader.reload("tooled.ts");
    // Its browser module may now describe the new tool's calls, and no longer the old one's.
    writeFileSync(join(dropIn, "tooled.ts"), module("tooled_b"));
    await loader.reload("tooled.ts");
    assert.equal(told, 2);
});

test("workflow declarations are cloned at registration and expose deeply frozen data", async () => {
    const { dropIn, loader, webs } = setUp();

    try {
        writeFileSync(
            join(dropIn, "clone.ts"),
            workflowModule(
                workflowDefinition("clone"),
                `definition.id = "clone:changed";
                definition.profiles[0].prompt = "Caller changed the prompt";
                definition.profiles.pop();
                definition.transitions[0].to = "clone:missing";
                definition.transitions[0].historyAny.length = 0;`,
            ),
        );
        await loader.reload("clone.ts");
        const profile = webs.profile("clone:write")!;
        const workflow = webs.workflowFor("clone:write")!;

        assert.equal(profile.prompt, "Registered playbook");
        assert.equal(workflow.id, "clone:flow");
        assert.ok(webs.profile("clone:review"));
        assert.deepEqual(webs.workflowOptions("clone:write", []), []);
        assert.deepEqual(webs.workflowOptions("clone:write", ["clone:review"]), [
            { targetType: "clone:review", relationship: "same-work", currentDiff: true },
        ]);
        assert.ok(
            [
                workflow,
                workflow.profiles,
                profile,
                workflow.transitions,
                workflow.transitions[0],
                workflow.transitions[0]!.historyAny,
            ].every(Object.isFrozen),
        );
        assert.equal(Reflect.set(profile, "prompt", "Consumer changed the prompt"), false);
        assert.equal(profile.prompt, "Registered playbook");
    } finally {
        await loader.close();
    }
});

test("workflow reloads are atomic, old disposal cannot remove a replacement, and disabling removes choices", async () => {
    const { dropIn, choices, loader, webs } = setUp();
    const finishDisposal = gate("workflow-dispose");

    try {
        writeFileSync(
            join(dropIn, "flow.ts"),
            workflowModule(
                workflowDefinition("flow"),
                `web.onDispose(async () => {
                    globalThis.cleaned.workflowDisposing = 1;
                    await globalThis.gates["workflow-dispose"];
                    globalThis.cleaned.workflowDisposed = 1;
                });`,
            ),
        );
        await loader.reload("flow.ts");
        writeFileSync(
            join(dropIn, "flow.ts"),
            workflowModule(
                workflowDefinition("flow", "discarded", "Rejected playbook"),
                `return { name: "t-workflow", sections: [{ key: "BAD" }] };`,
            ),
        );
        await assert.rejects(loader.reload("flow.ts"), /Section key "BAD"/);
        assert.equal(webs.profile("flow:write")?.prompt, "Registered playbook");
        assert.equal(webs.profile("flow:discarded"), undefined);
        assert.deepEqual(webs.workflowOptions("flow:write", ["flow:review"]), [
            { targetType: "flow:review", relationship: "same-work", currentDiff: true },
        ]);
        assert.equal(shared.cleaned!.workflowDisposing, undefined);

        writeFileSync(
            join(dropIn, "flow.ts"),
            workflowModule(workflowDefinition("flow", "finish", "Replacement playbook")),
        );
        await loader.reload("flow.ts");
        assert.equal(shared.cleaned!.workflowDisposing, 1);
        finishDisposal();
        await until(() => shared.cleaned!.workflowDisposed === 1, "old workflow disposal finishes");
        assert.equal(webs.profile("flow:write")?.prompt, "Replacement playbook");
        assert.equal(webs.profile("flow:review"), undefined);
        assert.deepEqual(webs.workflowOptions("flow:write", ["flow:finish"]), [
            { targetType: "flow:finish", relationship: "same-work", currentDiff: true },
        ]);

        choices.set("flow.ts", false);
        await loader.apply("flow.ts");
        assert.deepEqual(webs.profiles(), []);
        assert.equal(webs.workflowFor("flow:write"), undefined);
        assert.deepEqual(webs.workflowOptions("flow:write", ["flow:finish"]), []);
    } finally {
        finishDisposal();
        await loader.close();
    }
});

test("a superseded async workflow load never exposes or restores its staged profiles", async () => {
    const { dropIn, loader, webs } = setUp();
    const finishSlow = gate("workflow-slow");
    let pending: Promise<unknown> | undefined;

    try {
        writeFileSync(join(dropIn, "race.ts"), workflowModule(workflowDefinition("race")));
        await loader.reload("race.ts");
        writeFileSync(
            join(dropIn, "race.ts"),
            workflowModule(
                workflowDefinition("race", "obsolete", "Obsolete playbook"),
                `globalThis.cleaned.workflowStaged = 1;
                await globalThis.gates["workflow-slow"];`,
            ),
        );
        pending = loader.reload("race.ts");
        await until(() => shared.cleaned!.workflowStaged === 1, "slow workflow is staged");
        assert.equal(webs.profile("race:obsolete"), undefined);
        assert.equal(webs.profile("race:write")?.prompt, "Registered playbook");

        writeFileSync(
            join(dropIn, "race.ts"),
            workflowModule(workflowDefinition("race", "latest", "Latest playbook")),
        );
        await loader.reload("race.ts");
        finishSlow();
        await pending;
        pending = undefined;
        assert.deepEqual(
            webs.profiles().map((profile) => profile.id),
            ["race:write", "race:latest"],
        );
        assert.equal(webs.profile("race:write")?.prompt, "Latest playbook");
        assert.deepEqual(webs.workflowOptions("race:write", ["race:latest"]), [
            { targetType: "race:latest", relationship: "same-work", currentDiff: true },
        ]);
    } finally {
        finishSlow();
        await pending;
        await loader.close();
    }
});

test("workflow registration rejects reserved identities while the built-in is off and rejects privilege or dangling data", async () => {
    const { builtIn, dropIn, choices, loader, webs } = setUp();
    const trusted = {
        id: "work-items",
        profiles: [
            {
                id: "worker",
                name: "Worker",
                description: "Built-in implementation role.",
                prompt: "Built-in playbook",
                title: "Implementation",
            },
        ],
        transitions: [],
    };

    const source = (id: string) => {
        const definition = workflowDefinition("plugin");

        definition.profiles[0]!.id = id;
        definition.transitions[0]!.from = id;

        return definition;
    };

    const definition = workflowDefinition("plugin");
    const invalid = [
        {
            label: "reserved workflow",
            data: { ...definition, id: "work-items" },
            error: /must start with plugin:/,
        },
        { label: "reserved profile", data: source("worker"), error: /must start with plugin:/ },
        {
            label: "another module's profile",
            data: source("other:write"),
            error: /must start with plugin:/,
        },
        {
            label: "workflow privileges",
            data: { ...definition, capabilities: ["network"] },
            error: /unknown field/,
        },
        {
            label: "profile privileges",
            data: {
                ...definition,
                profiles: [
                    { ...definition.profiles[0], unrestricted: true },
                    definition.profiles[1],
                ],
            },
            error: /unknown field/,
        },
        {
            label: "dangling destination",
            data: {
                ...definition,
                transitions: [{ ...definition.transitions[0], to: "plugin:missing" }],
            },
            error: /reference a profile in this workflow/,
        },
    ];

    try {
        choices.set("work-items.ts", false);
        writeFileSync(join(builtIn, "work-items.ts"), workflowModule(trusted));
        writeFileSync(join(dropIn, "plugin.ts"), workflowModule(definition));
        await loader.loadAll();
        assert.equal(webs.profile("worker"), undefined);
        assert.ok(webs.profile("plugin:write"));

        for (const candidate of invalid) {
            writeFileSync(join(dropIn, "plugin.ts"), workflowModule(candidate.data));
            await assert.rejects(loader.reload("plugin.ts"), candidate.error, candidate.label);
            assert.equal(webs.profile("worker"), undefined, candidate.label);
            assert.deepEqual(
                webs.workflowOptions("plugin:write", ["plugin:review"]),
                [{ targetType: "plugin:review", relationship: "same-work", currentDiff: true }],
                candidate.label,
            );
        }

        // The same reserved IDs do work through the trusted built-in path, not merely a coincidental load failure.
        choices.set("work-items.ts", true);
        await loader.apply("work-items.ts");
        assert.equal(webs.profile("worker")?.prompt, "Built-in playbook");
        assert.equal(webs.workflowFor("worker")?.id, "work-items");
    } finally {
        await loader.close();
    }
});
