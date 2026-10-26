// The documentation's example extensions work as drop-ins.
import {
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));
const EXAMPLES = join(DOCS, "examples");

/** The system prompt of the newest request, and its sections by name. */
let prompt = "";
let sections: Record<string, string> = {};

const route: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);

    // The system prompt reaches the model as system messages, each with the sections that changed since the last.
    sections = Object.assign(
        {},
        ...(context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    prompt = Object.values(sections).join("\n");
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("what time")) {
        return call("clock", { zone: "UTC" });
    }

    if (text.includes("force push")) {
        return call("bash", { command: "git push --force origin main" });
    }

    if (text.includes("count the words")) {
        return call("my_word_count", { text: "one two  three" });
    }

    if (text.includes("plain push")) {
        return call("bash", { command: "echo git push origin main" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    // The examples, copied in as the owner would: into the data folder's extensions/, before the server starts.
    const data = join(root, "docs-data");
    const dropIns = join(data, "extensions");

    mkdirSync(dropIns, { recursive: true });

    // The modules, and the browser module beside one of them.
    for (const file of readdirSync(EXAMPLES).filter((each) => /\.(ts|js)$/.test(each))) {
        copyFileSync(join(EXAMPLES, file), join(dropIns, file));
    }

    app = await openApp(scriptedModel(route), data);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** What Pi's last answer in a session says. */
const answer = async (id: Parameters<typeof say>[1]) => (await modelTexts(app, id)).at(-1) ?? "";

test("the example extensions load as drop-ins, off until the owner turns them on, and work", async () => {
    const listed = (await app.extensions(owner(app))).modules.filter(
        (module) => module.source === "drop-in",
    );

    assert.deepEqual(
        listed.map((module) => [module.file, module.enabled]),
        [
            ["clock.ts", false],
            ["my-words.ts", false],
            ["no-force-push.ts", false],
            ["server-status.ts", false],
        ],
    );

    assert.ok(listed.every((module) => module.summary.length > 20));

    for (const file of ["clock.ts", "my-words.ts", "no-force-push.ts", "server-status.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    const id = await newSession(app);

    await say(app, id, "what time is it in UTC?");
    assert.match(await answer(id), /tool said: .*\d{4}.*\(UTC\)/);
    assert.match(prompt, /Do not force-push with git/);

    // The tutorial's module (docs/extensions/first-extension.md).
    await say(app, id, "count the words");
    assert.match(await answer(id), /tool said: 3 words/);

    await say(app, id, "force push it");
    assert.match(await answer(id), /Force-pushing is turned off here/);

    await say(app, id, "now a plain push");
    assert.match(await answer(id), /tool said: git push origin main/);

    // Server status adds to the app, not to Pi: a route, and a browser module for the owner's tabs.
    const status = app.webs.match("server-status", "GET", ["status"], owner(app));

    assert.ok(status !== undefined && "route" in status, "its route is there");
    const reading = (await status.route.handle({} as never)) as { cpus: number; load: number[] };

    assert.ok(reading.cpus > 0 && reading.load.length === 3);
    const [client] = app.webs.clients(owner(app));

    assert.equal(client?.module, "server-status");
});

test("the names reference names every built-in tool and extension a drop-in must not take the name of", async () => {
    const doc = readFileSync(join(DOCS, "extensions/reference/names.md"), "utf8");
    const builtIn = (await app.extensions(owner(app))).modules.filter(
        (module) => module.source === "built-in",
    );
    const tools = [
        "read",
        "write",
        "edit",
        "bash",
        ...builtIn.flatMap((module) => module.extensions.flatMap((each) => each.tools)),
    ];
    const names = builtIn.flatMap((module) => module.extensions.map((each) => each.name));

    // Lancet Guard starts off: the other modules are on, and Pi Durable's own tools come with them.
    assert.ok(tools.length >= 9 && names.length >= 8, "the built-ins are installed");

    for (const tool of tools) {
        assert.ok(doc.includes(`\`${tool}\``), `the built-in tool ${tool} is named`);
    }

    for (const name of names) {
        assert.match(
            name,
            /^(coding-tools|pocket-core|pocket-[a-z-]+)$/,
            `${name} fits what the doc says`,
        );
    }
});

test("the system prompt says where pi-tava's docs are, and every file it names exists", () => {
    const section = sections.pocket_docs ?? "";

    assert.match(section, /^<pocket_docs>\npi-tava documentation \(read only when/);
    // Every absolute path in it (the code, its docs, the data folder, Pi's docs), and every doc it names.
    const paths = [...section.matchAll(/(?<=\s)\/[^\s;,()]+/g)].map((match) =>
        match[0].replace(/\.$/, ""),
    );
    const named = [...section.matchAll(/\bdocs\/([a-z-]+(?:\.md|\/))/g)].map((match) =>
        join(DOCS, match[1]!),
    );

    assert.ok(paths.length >= 4, `the paths it gives: ${paths.join(", ")}`);
    assert.ok(named.length >= 6, "the docs it names");

    for (const path of [...paths, ...named]) {
        assert.ok(existsSync(path), `${path} exists`);
    }
});

test("every link between the docs leads to a file, and to a heading there when it names one", () => {
    const docs = [
        ...readdirSync(DOCS)
            .filter((file) => file.endsWith(".md"))
            .map((file) => join(DOCS, file)),
        resolve(DOCS, "../AGENTS.md"),
    ];
    const anchors = (file: string) =>
        new Set(
            [...readFileSync(file, "utf8").matchAll(/^#+ (.+)$/gm)].map((match) =>
                match[1]!
                    .toLowerCase()
                    .replace(/[^a-z0-9 _-]/g, "")
                    .replace(/ /g, "-"),
            ),
        );

    for (const doc of docs) {
        // Links in running text, not in code.
        const text = readFileSync(doc, "utf8")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`\n]*`/g, "");

        for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
            if (/^[a-z]+:/.test(target!)) {
                continue;
            }

            const [path, anchor] = target!.split("#");
            const file = path === "" ? doc : resolve(dirname(doc), path!);

            assert.ok(existsSync(file), `${doc}: ${target} leads to a file`);

            if (anchor !== undefined && file.endsWith(".md")) {
                assert.ok(anchors(file).has(anchor), `${doc}: ${target} leads to a heading`);
            }
        }
    }
});
