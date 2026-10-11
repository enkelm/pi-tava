import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigStore } from "../src/server/config.ts";
import { ProviderPackages, PI_PROVIDERS_FILE } from "../src/server/provider-packages.ts";

const NAME = "pi-provider-litellm";
const pin = (version: string) => `npm:${NAME}@${version}`;

/** Uses the supported npmCommand boundary, not a test-only controller injection API. */
async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const root = await mkdtemp(join(tmpdir(), "coop-provider-packages-"));
    const agentDir = join(root, "ordinary-pi");
    const dataDir = join(root, "coop");
    const bin = join(root, "bin");
    const npm = join(bin, "npm");
    const config = new ConfigStore(dataDir);
    const packages = new ProviderPackages(config, dataDir, agentDir);

    await mkdir(agentDir, { recursive: true });
    await mkdir(bin);
    // Scripted external installer/registry transport: no network or actual npm install.
    await writeFile(
        npm,
        `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), base = path.dirname(__dirname);
fs.appendFileSync(path.join(base, "commands.jsonl"), JSON.stringify(args) + "\\n");
if (args.includes("root")) {
    console.log(path.join(base, "legacy-node_modules"));
} else if (args.includes("view")) {
    console.log(fs.readFileSync(path.join(base, "latest.json"), "utf8"));
} else if (args.includes("install")) {
    if (!args.includes("--ignore-scripts") || !args.includes("--legacy-peer-deps")) {
        console.error("unsafe script/peer policy"); process.exit(7);
    }
    if (fs.existsSync(path.join(base, "hang"))) {
        process.on("SIGTERM", () => {});
        fs.writeFileSync(path.join(base, "npm.pid"), String(process.pid));
        require("node:child_process").spawn(process.execPath, ["-e", "const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20)", path.join(base,"descendant.pid"), path.join(base,"heartbeat")], {stdio:"ignore"});
        setInterval(() => {}, 1000);
        return;
    }
    if (fs.existsSync(path.join(base, "fail"))) {
        console.error("registry failed: SECRET-REGISTRY-TOKEN"); process.exit(9);
    }
    const spec = args[args.indexOf("install") + 1], at = spec.lastIndexOf("@");
    const name = spec.slice(0, at), version = spec.slice(at + 1);
    const prefix = args[args.indexOf("--prefix") + 1], root = path.join(prefix, "node_modules", name);
    fs.mkdirSync(path.join(root, "src"), {recursive:true});
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({name, version, pi:{extensions:["./src/index.ts"]}}));
    fs.writeFileSync(path.join(root, "src/index.ts"), "throw new Error('INSTALL MUST NOT IMPORT EXTENSIONS')");
    const packages = {"":{dependencies:{[name]:version}}, ["node_modules/"+name]:{version, integrity:"fixture-"+version}};
    if (fs.existsSync(path.join(base, "duplicate"))) {
        packages["node_modules/"+name+"/node_modules/@earendil-works/pi-ai"] = {version:"1.1.0"};
    }
    fs.writeFileSync(path.join(prefix, "package-lock.json"), JSON.stringify({lockfileVersion:3, packages}));
} else {
    console.error("unexpected transport command"); process.exit(8);
}
`,
    );
    await chmod(npm, 0o700);
    const settings = JSON.stringify({
        npmCommand: [npm, "--ignore-scripts=false", "--legacy-peer-deps=false"],
        packages: [
            { source: pin("^4.2.0"), extensions: ["src/index.ts"] },
            "npm:pi-provider-cursor@1.0.0",
            "https://SECRET-URL@example.invalid/not-npm",
            "./not-a-package",
        ],
        litellm: { apiKey: "SECRET-PI-KEY", headers: { Authorization: "SECRET-PI-HEADER" } },
    });

    await writeFile(join(agentDir, "settings.json"), settings);
    await writeFile(join(agentDir, "auth.json"), '{"litellm":{"key":"SECRET-AUTH"}}');
    await writeFile(join(root, "latest.json"), '"4.3.0"');
    await installed(agentDir, NAME, "4.2.0", root);
    await installed(agentDir, "pi-provider-cursor", "1.0.0", root);
    t.after(async () => {
        await packages.close();
        await rm(root, { recursive: true, force: true });
    });

    const reopen = () => {
        const controller = new ProviderPackages(new ConfigStore(dataDir), dataDir, agentDir);

        t.after(() => controller.close());

        return controller;
    };

    return { root, agentDir, dataDir, config, packages, settings, reopen };
}

async function installed(agentDir: string, name: string, version: string, fixtureRoot: string) {
    const root = join(agentDir, "npm", "node_modules", name);

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name, version, pi: { extensions: ["./src/index.ts"] } }),
    );
    await writeFile(
        join(root, "src/index.ts"),
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(fixtureRoot, "executed"))}, 'oops'); throw new Error('discovery executed code');`,
    );
}

test("discovery is metadata-only, global npm-only, opaque and secret-free", async (t) => {
    const f = await fixture(t);

    await mkdir(join(f.dataDir, "provider-packages", ".pi"), { recursive: true });
    await writeFile(
        join(f.dataDir, "provider-packages", ".pi", "settings.json"),
        JSON.stringify({ packages: ["npm:project-provider@1.0.0"] }),
    );
    const result = await f.packages.list();
    const litellm = result.available.find((row) => row.name === NAME)!;
    const cursor = result.available.find((row) => row.name === "pi-provider-cursor")!;

    assert.equal(result.enabled, false);
    assert.equal(result.available.length, 2);
    assert.equal(litellm.compatible, true);
    assert.equal(litellm.source, pin("4.2.0"));
    assert.match(litellm.id, /^[a-f0-9]{64}$/);
    assert.equal(cursor.compatible, false);
    assert.match(cursor.reason!, /No supported/);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes(f.root), false);
    await assert.rejects(access(join(f.root, "executed")));
    await assert.rejects(f.packages.selectInstalled("../../ordinary-pi"), /expired/);
    await assert.rejects(f.packages.selectInstalled(cursor.id), /No supported/);
    await assert.rejects(access(join(f.root, "commands.jsonl")));
    await installed(f.agentDir, NAME, "5.0.0", f.root);
    assert.equal(
        (await f.packages.list()).available.find((row) => row.name === NAME)!.compatible,
        false,
    );
    assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), f.settings);
    const discoverySettings = JSON.parse(f.settings);

    discoverySettings.packages.push("npm:missing-provider@1.0.0");
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify(discoverySettings));
    f.config.setExtensionEnabled(PI_PROVIDERS_FILE, true);
    const sharedModule = f.packages.moduleState();

    assert.equal(sharedModule.enabled, true);
    assert.equal(sharedModule.activeEnabled, false);
    assert.equal(sharedModule.restartRequired, true);
    assert.equal("available" in sharedModule, false);
    await assert.rejects(access(join(f.root, "commands.jsonl")));
    // Positive control: owner list really does resolve the missing configured npm root.
    await f.packages.list();
    assert.match(await readFile(join(f.root, "commands.jsonl"), "utf8"), /"root"/);
});

test("staging/settings/toggles persist but activate only after successful startup acknowledgement", async (t) => {
    const f = await fixture(t);
    const discovery = (await f.packages.list()).available.find((row) => row.name === NAME)!;
    const staged = await f.packages.selectInstalled(discovery.id);

    assert.equal(staged.packages[0]!.version, "4.2.0");
    assert.equal(staged.packages[0]!.active, false);
    await f.packages.configure(NAME, {
        baseUrl: "https://proxy.example/v1",
        aliases: { secondary: "https://secondary.example/v1" },
    });
    await f.packages.setModuleEnabled(true);
    assert.equal(f.config.extensionChoice(PI_PROVIDERS_FILE), true);
    const selection = (await f.packages.startup())[0]!;
    const before = await f.packages.list();
    const settings = JSON.parse(await readFile(join(selection.agentDir, "settings.json"), "utf8"));

    assert.equal(before.activeEnabled, false);
    assert.equal(before.restartRequired, true);
    assert.equal(selection.profile, "litellm");
    assert.deepEqual(selection.providerIds, ["litellm", "secondary"]);
    assert.notEqual(selection.agentDir, f.agentDir);
    assert.deepEqual(settings.litellm.mcp, { enabled: false });
    assert.deepEqual(settings.litellm.skills, { enabled: false });
    assert.deepEqual(settings.litellm.budget, { enabled: false });
    assert.equal(settings.litellm.providers.secondary.baseUrl, "https://secondary.example/v1");
    assert.equal(JSON.stringify(settings).includes("SECRET"), false);
    await assert.rejects(access(join(selection.agentDir, "auth.json")));
    f.packages.markStartupApplied();
    assert.equal((await f.packages.list()).restartRequired, false);
    await f.packages.setEnabled(NAME, false);
    await f.packages.setModuleEnabled(false);
    const pending = await f.packages.list();

    assert.equal(pending.packages[0]!.active, true);
    assert.equal(pending.activeEnabled, true);
    assert.equal(pending.restartRequired, true);
    const reopened = f.reopen();

    assert.equal((await reopened.list()).packages[0]!.enabled, false);
    assert.deepEqual(await reopened.startup(), []);
    reopened.markStartupApplied();
    assert.equal((await reopened.list()).restartRequired, false);
    assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), f.settings);
    assert.equal(
        await readFile(join(f.agentDir, "auth.json"), "utf8"),
        '{"litellm":{"key":"SECRET-AUTH"}}',
    );
});

test("manual update stages exact pins without mutating active code/lock; rollback retains whole releases", async (t) => {
    const f = await fixture(t);

    await f.packages.install(pin("4.2.0"));
    await f.packages.setModuleEnabled(true);
    const first = (await f.packages.startup())[0]!;

    f.packages.markStartupApplied();
    const originalCode = await readFile(join(first.root, "src", "index.ts"), "utf8");
    const lockPath = join(first.root, "..", "..", "package-lock.json");
    const originalLock = await readFile(lockPath, "utf8");
    const updated = await f.packages.update(NAME);

    assert.equal(updated.packages[0]!.version, "4.3.0");
    assert.equal(updated.packages[0]!.activeVersion, "4.2.0");
    assert.equal(updated.packages[0]!.status, "staged");
    assert.equal(await readFile(join(first.root, "src", "index.ts"), "utf8"), originalCode);
    assert.equal(await readFile(lockPath, "utf8"), originalLock);
    const commands = (await readFile(join(f.root, "commands.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

    assert.equal(commands.filter((args) => args.includes("view")).length, 1);

    for (const args of commands.filter((args) => args.includes("install"))) {
        assert.ok(args.includes("--legacy-peer-deps"), "npm must not auto-install host peers");
        assert.ok(
            args.lastIndexOf("--legacy-peer-deps") > args.lastIndexOf("--legacy-peer-deps=false"),
        );
        assert.ok(
            args.lastIndexOf("--ignore-scripts") > args.lastIndexOf("--ignore-scripts=false"),
        );
    }

    assert.equal(
        commands
            .filter((args) => args.includes("install"))
            .at(-1)
            .includes(`${NAME}@4.3.0`),
        true,
    );
    const candidate = (await f.reopen().startup())[0]!;

    assert.equal(candidate.version, "4.3.0");
    assert.equal(candidate.previous?.version, "4.2.0");
    assert.equal(candidate.previous?.root, first.root);
    assert.notEqual(candidate.root, first.root);
    const rolledBack = await f.packages.rollback(NAME);

    assert.equal(rolledBack.packages[0]!.version, "4.2.0");
    assert.equal(rolledBack.packages[0]!.activeVersion, "4.2.0");
    assert.equal((await readdir(join(f.dataDir, "provider-packages", "releases"))).length, 2);
    await assert.rejects(f.packages.startup(), /once per process/);
});

test("stage failures, unsafe specs/settings and duplicate host runtimes leave saved/active selections intact", async (t) => {
    const f = await fixture(t);

    await f.packages.install(pin("4.2.0"));
    await f.packages.setModuleEnabled(true);
    const first = (await f.packages.startup())[0]!;

    f.packages.markStartupApplied();
    const saved = JSON.stringify(f.config.providerPackages);

    for (const source of [
        pin(""),
        pin("latest"),
        pin("^4.2.0"),
        pin("4.3.0 --global"),
        "git:https://example.invalid/code",
        "npm:../../escape@4.2.0",
        pin("5.0.0"),
    ]) {
        await assert.rejects(f.packages.install(source));
        assert.equal(JSON.stringify(f.config.providerPackages), saved);
    }

    for (const settings of [
        { apiKey: "SECRET" },
        { headers: { authorization: "SECRET" } },
        { baseUrl: "https://user:SECRET@example.invalid" },
        { baseUrl: "https://example.invalid?api_key=SECRET" },
        { aliases: { alias: "$(run-command)" } },
    ]) {
        await assert.rejects(f.packages.configure(NAME, settings));
        assert.equal(JSON.stringify(f.config.providerPackages), saved);
    }

    await writeFile(join(f.root, "fail"), "");
    await assert.rejects(f.packages.install(pin("4.3.0")), /installation failed/);
    assert.equal(JSON.stringify(f.config.providerPackages), saved);
    assert.equal((await f.packages.list()).packages[0]!.activeVersion, "4.2.0");
    assert.equal(JSON.stringify(await f.packages.list()).includes("SECRET"), false);
    assert.deepEqual(await readdir(join(f.dataDir, "provider-packages", "staging")), []);
    await rm(join(f.root, "fail"));
    await writeFile(join(f.root, "duplicate"), "");
    await assert.rejects(f.packages.install(pin("4.3.0")), /duplicate Pi/);
    assert.equal(JSON.stringify(f.config.providerPackages), saved);
    assert.equal(
        JSON.parse(await readFile(join(first.root, "package.json"), "utf8")).version,
        "4.2.0",
    );
});

test("startup failure falls back to last-applied complete configuration, not latest staged predecessor", async (t) => {
    const f = await fixture(t);

    await f.packages.install(pin("4.2.0"));
    await f.packages.configure(NAME, {
        baseUrl: "https://lastgood.example",
        aliases: { good: "https://good.example" },
    });
    await f.packages.setModuleEnabled(true);
    const lastgood = (await f.packages.startup())[0]!;

    f.packages.markStartupApplied();
    await f.packages.install(pin("4.3.0"));
    await f.packages.install(pin("4.4.0"));
    await f.packages.configure(NAME, {
        baseUrl: "https://candidate.example",
        aliases: { candidate: "https://new.example" },
    });
    const before = await readFile(f.config.file, "utf8");
    const reopened = f.reopen();
    const candidate = (await reopened.startup())[0]!;

    assert.equal(candidate.previous?.version, "4.3.0");
    assert.notEqual(candidate.modelsStorePath, lastgood.modelsStorePath);
    assert.equal((await reopened.list()).packages[0]!.active, false);
    reopened.markStartupFailed();
    const fallback = (await reopened.fallbackStartup())[0]!;

    assert.equal(fallback.version, "4.2.0");
    assert.equal(fallback.root, lastgood.root);
    assert.equal(fallback.modelsStorePath, lastgood.modelsStorePath);
    assert.deepEqual(fallback.providerIds, ["litellm", "good"]);
    const settings = JSON.parse(await readFile(join(fallback.agentDir, "settings.json"), "utf8"));

    assert.equal(settings.litellm.providers.litellm.baseUrl, "https://lastgood.example");
    reopened.markStartupFallbackApplied();
    const snapshot = await reopened.list();

    assert.equal(snapshot.packages[0]!.version, "4.4.0");
    assert.equal(snapshot.packages[0]!.activeVersion, "4.2.0");
    assert.equal(snapshot.restartRequired, true);
    assert.match(snapshot.error!, /last applied/);
    assert.equal(await readFile(f.config.file, "utf8"), before);
    const recovered = await reopened.rollback(NAME);

    assert.equal(recovered.packages[0]!.version, "4.2.0");
    assert.equal(snapshot.packages[0]!.previousVersion, recovered.packages[0]!.version);
    assert.equal(recovered.packages[0]!.activeVersion, "4.2.0");
    assert.equal(recovered.packages[0]!.previousVersion, "4.4.0");
    assert.deepEqual(recovered.packages[0]!.settings, {
        baseUrl: "https://lastgood.example",
        aliases: { good: "https://good.example" },
    });
    assert.equal(recovered.restartRequired, false);
    assert.equal(
        new ConfigStore(f.dataDir).providerPackages.packages[0]!.previous?.version,
        "4.4.0",
    );
    const reversed = await reopened.rollback(NAME);

    assert.equal(reversed.packages[0]!.version, "4.4.0");
    assert.equal(reversed.packages[0]!.activeVersion, "4.2.0");
    assert.equal(reversed.restartRequired, true);
    await reopened.setModuleEnabled(false);
    assert.deepEqual(await reopened.fallbackStartup(), []);
});

test("catalog cache survives isolated home reconstruction and is scoped to canonical public configuration", async (t) => {
    const f = await fixture(t);

    await f.packages.install(pin("4.2.0"));
    await f.packages.configure(NAME, {
        baseUrl: "https://proxy.example",
        aliases: { alpha: "https://a.example", beta: "https://b.example" },
    });
    await f.packages.setModuleEnabled(true);
    const first = (await f.packages.startup())[0]!;

    f.packages.markStartupApplied();
    const cachedCatalog = JSON.stringify({ models: [{ id: "cached-chat", provider: "litellm" }] });
    const firstSettingsText = await readFile(join(first.agentDir, "settings.json"), "utf8");

    await writeFile(first.modelsStorePath, cachedCatalog, { mode: 0o600 });
    await f.packages.close();
    await assert.rejects(access(first.agentDir));
    const reconstructed = f.reopen();

    await reconstructed.configure(NAME, {
        aliases: { beta: "https://b.example", alpha: "https://a.example" },
        baseUrl: "https://proxy.example",
    });
    const same = (await reconstructed.startup())[0]!;

    assert.notEqual(same.agentDir, first.agentDir);
    assert.equal(same.modelsStorePath, first.modelsStorePath);
    assert.equal(await readFile(join(same.agentDir, "settings.json"), "utf8"), firstSettingsText);
    assert.equal(await readFile(same.modelsStorePath, "utf8"), cachedCatalog);
    assert.equal(same.modelsStorePath.startsWith(same.agentDir), false);
    await reconstructed.configure(NAME, {
        baseUrl: "https://changed.example",
        aliases: { alpha: "https://a.example", beta: "https://b.example" },
    });
    const changed = (await f.reopen().startup())[0]!;

    assert.notEqual(changed.modelsStorePath, first.modelsStorePath);
    await assert.rejects(access(changed.modelsStorePath));
    assert.equal(await readFile(first.modelsStorePath, "utf8"), cachedCatalog);
    assert.equal(await readFile(join(f.agentDir, "settings.json"), "utf8"), f.settings);
});

test(
    "close bounds a stuck SDK installer and stops its npm descendants without touching other processes",
    { timeout: 15_000 },
    async (t) => {
        const f = await fixture(t);
        const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
            stdio: "ignore",
        });

        try {
            await writeFile(join(f.root, "hang"), "");
            const rejected = assert.rejects(f.packages.install(pin("4.2.0")), /cancelled/);
            let ready = false;

            for (let attempt = 0; attempt < 100; attempt++) {
                try {
                    await access(join(f.root, "heartbeat"));
                    ready = true;
                    break;
                } catch {
                    await delay(50);
                }
            }

            assert.equal(
                ready,
                true,
                "fake npm descendant must actually be running before shutdown",
            );
            const started = Date.now();

            await Promise.race([
                f.packages.close(),
                delay(3_000).then(() => {
                    throw new Error("installer shutdown was not bounded");
                }),
            ]);
            await rejected;
            assert.ok(Date.now() - started < 3_000);
            const stopped = await readFile(join(f.root, "heartbeat"), "utf8");

            await delay(150);
            assert.equal(await readFile(join(f.root, "heartbeat"), "utf8"), stopped);
            assert.equal(f.config.providerPackages.packages.length, 0);
            assert.deepEqual(await readdir(join(f.dataDir, "provider-packages", "staging")), []);
            assert.equal(process.kill(unrelated.pid!, 0), true);
        } finally {
            // Fixture-only safety cleanup also makes failures on the old unbounded implementation exit.
            for (const file of ["npm.pid", "descendant.pid"]) {
                try {
                    process.kill(Number(await readFile(join(f.root, file), "utf8")), "SIGKILL");
                } catch {
                    // Already terminated, or startup failed before writing the fixture PID.
                }
            }

            unrelated.kill("SIGKILL");
        }
    },
);
