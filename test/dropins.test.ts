// Drop-in extensions: the owner's own modules in the data folder load like built-in ones, but only once turned on.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpClient } from "@earendil-works/pi-mcp";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");

/** A drop-in that imports Pi Durable and pi-ai by name, offers a tool, and blocks bash with a hook. */
const shout = (suffix: string) => `/** Shout offers a tool that shouts${suffix}. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";

export const durableToolApi = 2;
export default () =>
	defineExtension({
		name: "shout",
		tools: [
			defineTool({
				name: "shout",
				description: "Shout",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (args) => ({ output: [{ type: "text", text: args.text.toUpperCase() + "${suffix}" }] }),
			}),
		],
		hooks: [hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "no shell while shouting" } : undefined) })],
	});
`;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.endsWith("shout hello")) {
        return call("shout", { text: "hello" });
    }

    if (text.endsWith("list files")) {
        return call("bash", { command: "ls" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "shout.ts"), shout("!"));
    // Neither a real built-in nor the virtual provider-compatibility row can be replaced by a drop-in.

    for (const file of ["plan.ts", "pi-providers.ts"]) {
        writeFileSync(
            join(dropIns, file),
            "export default () => { throw new Error('a drop-in must not replace a built-in'); };",
        );
    }

    app = await openApp(model, dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

const module = (file: string) => app.loader.list().filter((each) => each.file === file);

test("drop-ins are off until the owner turns them on, and cannot replace a built-in module", async () => {
    const [listed] = module("shout.ts");

    assert.equal(listed?.source, "drop-in");
    assert.equal(listed?.enabled, false);
    assert.deepEqual(
        module("plan.ts").map((each) => each.source),
        ["built-in"],
    );
    assert.deepEqual(
        module("pi-providers.ts"),
        [],
        "the compatibility row is not a watched module",
    );
    const compatibility = (await app.extensions(owner(app))).modules.filter(
        (each) => each.file === "pi-providers.ts",
    );

    assert.equal(compatibility.length, 1);
    assert.equal(compatibility[0]?.source, "built-in");
    assert.equal(compatibility[0]?.restartOnly, true);
    assert.deepEqual(compatibility[0]?.extensions, []);
    await assert.rejects(app.reloadExtension("pi-providers.ts"), /require a server restart/);
    // Where the server keeps files is the owner's to know.
    const scoped = app.config.addUser("Sid", "guest", ["1"]).user;
    const seen = await app.extensions(scoped);

    assert.equal(seen.dropIns, undefined);
    assert.equal(seen.modules.find((each) => each.file === "shout.ts")?.path, undefined);
    assert.equal((await app.extensions(owner(app))).dropIns, dropIns);
    // Pi Pocket's types beside the drop-ins: a link to them, never a module.
    assert.equal(
        realpathSync(join(dropIns, "_pocket.d.ts")),
        realpathSync(new URL("../types/pocket.d.ts", import.meta.url)),
    );
    assert.deepEqual(module("_pocket.d.ts"), []);
});

test("drop-ins can import the directly supported MCP client through their package link", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const installed = JSON.parse(
        readFileSync(
            new URL("../node_modules/@earendil-works/pi-mcp/package.json", import.meta.url),
            "utf8",
        ),
    );

    assert.equal(manifest.dependencies["@earendil-works/pi-mcp"], installed.version);
    const source = join(dropIns, "_mcp-import.ts");

    writeFileSync(source, 'export { McpClient } from "@earendil-works/pi-mcp";\n');
    const imported = await import(pathToFileURL(source).href);

    assert.equal(imported.McpClient, McpClient, "drop-ins and the server use one MCP module");
});

test("_pocket.d.ts: a link the owner pointed elsewhere stays, and only Pi Pocket's own copy is refreshed", async () => {
    const { linkTypes } = await import("../src/server/reload.ts");
    const types = realpathSync(new URL("../types/pocket.d.ts", import.meta.url));
    const folder = join(root, "types-link");
    const elsewhere = join(root, "their-pocket.d.ts");
    const link = join(folder, "_pocket.d.ts");

    mkdirSync(folder, { recursive: true });
    writeFileSync(elsewhere, "export {};\n");
    symlinkSync(elsewhere, link, "file");
    linkTypes(folder, types);
    assert.equal(realpathSync(link), realpathSync(elsewhere));

    // Where links cannot be made, Pi Pocket keeps a copy: a stale one is refreshed, a file of the owner's is not.
    rmSync(link);
    const mark =
        "// A copy of Pi Pocket's types/pocket.d.ts: Pi Pocket refreshes it at each start. Edits here are lost.\n";

    writeFileSync(link, `${mark}export type Old = 1;\n`);
    linkTypes(folder, types);
    assert.equal(readFileSync(link, "utf8"), mark + readFileSync(types, "utf8"));
    writeFileSync(link, "export type Mine = 1;\n");
    linkTypes(folder, types);
    assert.equal(readFileSync(link, "utf8"), "export type Mine = 1;\n");
});

test("a drop-in that is on gives Pi its tools and hooks, reloads when edited, and goes away when deleted", async () => {
    await app.setExtensionEnabled(owner(app), "shout.ts", true);
    assert.deepEqual(module("shout.ts")[0]?.extensions, [
        {
            name: "shout",
            tools: ["shout"],
            readOnlyTools: [],
            hooks: ["beforeTool"],
            sections: [],
            wraps: [],
        },
    ]);
    const id = await newSession(app);

    await say(app, id, "shout hello");
    await say(app, id, "list files");
    const said = (await modelTexts(app, id)).join("\n");

    assert.match(said, /tool said: HELLO!/);
    assert.match(said, /no shell while shouting/, "its hook runs on the built-in bash tool");

    // The owner's tab hears when the edited file is reloaded.
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    app.loader.watch();

    try {
        writeFileSync(join(dropIns, "shout.ts"), shout("!!"));
        const notices = () =>
            tab.events
                .filter((each) => each.event === "notice")
                .map((each) => String(each.data.message));

        await until(
            () => notices().includes("Reloaded shout.ts: shout"),
            "the edited file to be reloaded",
        );
        await say(app, id, "shout hello");
        assert.match((await modelTexts(app, id)).join("\n"), /tool said: HELLO!!/);

        rmSync(join(dropIns, "shout.ts"));
        await until(
            () => notices().includes("Removed the drop-in extension shout.ts."),
            "the deleted drop-in to be uninstalled",
        );
        assert.equal(app.loader.extensionNames().includes("shout"), false);
        assert.deepEqual(module("shout.ts"), []);
    } finally {
        app.detach(tab.client);
    }
});

/** A drop-in with one extension, and one tool in it when `tool` is given. */
const named = (extension: string, tool?: string) => `/** ${extension}, for the names test. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export const durableToolApi = 2;
export default () =>
	defineExtension({
		name: "${extension}",
		tools: [${
            tool === undefined
                ? ""
                : `defineTool({ name: "${tool}", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "${extension}" }] }) })`
        }],
	});
`;

test("a drop-in cannot take a name Pi Pocket keeps, or one another module has: it is refused", async () => {
    const refused = async (file: string, source: string, why: RegExp) => {
        writeFileSync(join(dropIns, file), source);
        await assert.rejects(app.setExtensionEnabled(owner(app), file, true), why);
        assert.deepEqual(module(file)[0]?.extensions, [], `${file} installed nothing`);
    };

    // Lancet Guard's name, while the guard is off: turning it on later would replace the drop-in, and the drop-in
    // turned off would remove the guard.
    await refused("guard-twin.ts", named("pocket-guard"), /pocket-guard is pi-tava's own/);
    await refused("my-tools.ts", named("coding-tools"), /coding-tools is pi-tava's own/);
    await refused("core-twin.ts", named("pocket-core"), /pocket-core is pi-tava's own/);
    await refused("my-bash.ts", named("my-bash", "bash"), /bash is a built-in tool's/);
    await refused("my-browser.ts", named("my-browser", "browser"), /browser is a built-in tool's/);

    // Another drop-in's: the first one in keeps it.
    writeFileSync(join(dropIns, "first.ts"), named("first", "greet"));
    await app.setExtensionEnabled(owner(app), "first.ts", true);
    const first = {
        name: "first",
        tools: ["greet"],
        readOnlyTools: [],
        hooks: [],
        sections: [],
        wraps: [],
    };

    assert.deepEqual(module("first.ts")[0]?.extensions, [first]);
    await refused(
        "second.ts",
        named("second", "greet"),
        /first\.ts already has a tool named greet/,
    );
    await refused(
        "third.ts",
        named("first"),
        /first\.ts already installs an extension named first/,
    );

    // An edit cannot replace coding tools or the always-on workflow core; the working version remains.
    for (const tool of ["bash", "handoff", "publication", "pull"]) {
        writeFileSync(join(dropIns, "first.ts"), named("first", tool));
        await assert.rejects(
            app.loader.reload("first.ts"),
            new RegExp(`${tool} is a built-in tool's`),
        );
        assert.deepEqual(module("first.ts")[0]?.extensions, [first]);
    }

    // Reloading its own working version is not a clash with itself.
    writeFileSync(join(dropIns, "first.ts"), named("first", "greet"));
    await app.loader.reload("first.ts");
    assert.equal(module("first.ts")[0]?.error, undefined);
});

test("the built-in tool names a drop-in may not take are every tool the built-ins install", async () => {
    const { BUILT_IN_TOOLS } = await import("../src/server/reload.ts");
    const disabled = app.loader
        .list()
        .filter((each) => each.source === "built-in" && !each.enabled);

    try {
        // Agent Teams is off by default, but its tool name is reserved even then.
        for (const each of disabled) {
            await app.setExtensionEnabled(owner(app), each.file, true);
        }

        const conversation = await app.conversation(await newSession(app));
        const agent = await conversation.agent(context);
        const pip = await app.conversation(await app.pip.ensure(owner(app)));
        const pipAgent = await pip.agent(context);
        // Ordinary sessions exclude PiP. Together their real selections cover the installed built-ins,
        // including the always-on core; the virtual provider row is not a registered extension.
        const extensions = new Map(
            [...agent.extensions, ...pipAgent.extensions].map((extension) => [
                extension.name,
                extension,
            ]),
        );
        const installed = [...extensions.values()]
            .filter((extension) => /^(pocket-.*|coding-tools)$/.test(extension.name))
            .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));

        assert.ok(installed.length >= 9, "the built-ins are on");
        // The core and private selection share handoff's descriptor; reserved names form a set.
        assert.deepEqual([...new Set(installed)].sort(), [...BUILT_IN_TOOLS].sort());
    } finally {
        for (const each of disabled) {
            await app.setExtensionEnabled(owner(app), each.file, false);
        }
    }
});
