// Build the canonical paint-only terminal renderer offline. Never connects to Herdr.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "native/herdr-renderer");
const target = join(source, "target");
const manifest = join(source, "Cargo.toml");
const cargo = ["+1.96.0"];
const locked = ["--offline", "--locked", "--manifest-path", manifest, "--target-dir", target];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });

    if (result.error || result.status !== 0) {
        throw new Error(`${command} failed: ${result.error?.message || result.status}`);
    }
}

if (process.argv.length === 3 && process.argv[2] === "--test") {
    run("cargo", [
        ...cargo,
        "test",
        ...locked,
        "-p",
        "herdr-renderer-frame",
        "-p",
        "herdr-renderer-font",
    ]);
    process.exit(0);
}

if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/build-herdr-renderer.mjs [--test]");
}

const lock = readFileSync(join(source, "Cargo.lock"), "utf8");
const version = lock.match(/\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
const installed = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });

if (!version || installed.status !== 0 || installed.stdout.trim() !== `wasm-bindgen ${version}`) {
    throw new Error(
        `The renderer requires preinstalled wasm-bindgen-cli ${version || "matching Cargo.lock"}. See native/herdr-renderer/README.md.`,
    );
}

run("cargo", [...cargo, "build", ...locked, "--release", "--target", "wasm32-unknown-unknown"]);
const staging = mkdtempSync(join(target, "renderer-assets-"));
let publishing;
let manifestTemporary;

function files(directory, prefix = "") {
    return readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .flatMap((entry) => {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

            return entry.isDirectory() ? files(join(directory, entry.name), relative) : [relative];
        });
}

function digest(directory) {
    const hash = createHash("sha256");

    for (const name of files(directory)) {
        hash.update(name);
        hash.update("\0");
        hash.update(readFileSync(join(directory, name)));
    }

    return hash.digest("hex");
}

try {
    run("wasm-bindgen", [
        join(target, "wasm32-unknown-unknown/release/herdr_renderer.wasm"),
        "--target",
        "web",
        "--no-typescript",
        "--out-dir",
        join(staging, "pkg"),
        "--out-name",
        "herdr_renderer",
    ]);

    for (const name of [
        "index.html",
        "renderer.js",
        "style.css",
        "LICENSE-APACHE",
        "NOTICE-HERDR",
        "NOTICE-PROTOCOL.md",
        "UPSTREAM.md",
        "upstream-files.json",
        ...readdirSync(join(source, "fonts"))
            .filter((name) => /\.(md|txt)$/i.test(name))
            .map((name) => `fonts/${name}`),
    ]) {
        const destination = join(staging, name);

        mkdirSync(join(destination, ".."), { recursive: true });
        cpSync(join(source, name), destination);
    }

    const wasm = readFileSync(join(staging, "pkg/herdr_renderer_bg.wasm"));

    assert.ok(WebAssembly.validate(wasm), "The generated WebAssembly module failed validation.");

    for (const name of files(staging).filter((name) => name.endsWith(".js"))) {
        run(process.execPath, ["--check", join(staging, name)]);
    }

    // Exercise the real generated JS/WASM interface without starting graphics or accessing a pane.
    const bindings = await import(pathToFileURL(join(staging, "pkg/herdr_renderer.js")).href);

    const compiled = await WebAssembly.compile(wasm);

    await bindings.default({ module_or_path: structuredClone(compiled) });
    assert.equal(typeof bindings.start, "function");
    assert.throws(
        () => bindings.present("{}", 1),
        (error) => error === "The renderer is not ready.",
    );
    assert.throws(
        () => bindings.clear(2),
        (error) => error === "The renderer is not ready.",
    );

    const contentHash = digest(staging);
    const revision = contentHash.slice(0, 16);
    const output = join(root, "web/herdr-renderer");
    const versioned = join(output, revision);

    mkdirSync(output, { recursive: true });

    if (!existsSync(versioned)) {
        publishing = mkdtempSync(join(output, ".assets-"));
        cpSync(staging, publishing, { recursive: true });

        try {
            renameSync(publishing, versioned);
        } catch (error) {
            // Another identical build may have completed first. Never overwrite an immutable build.
            if (!existsSync(versioned) || digest(versioned) !== contentHash) {
                throw error;
            }
        }
    }

    assert.equal(
        digest(versioned),
        contentHash,
        "Existing renderer assets are incomplete or changed.",
    );
    manifestTemporary = join(output, `build-${process.pid}-${revision}.tmp`);
    writeFileSync(
        manifestTemporary,
        `${JSON.stringify({ schema: 2, kind: "live-terminal", entry: `${revision}/index.html`, wasmBytes: wasm.length })}\n`,
    );
    // Switch only after the complete immutable build and its generated interface have passed checks.
    renameSync(manifestTemporary, join(output, "build.json"));
    console.log(`Terminal renderer ready: ${versioned} (${wasm.length} WASM bytes).`);
} finally {
    rmSync(staging, { recursive: true, force: true });

    if (publishing) {
        rmSync(publishing, { recursive: true, force: true });
    }

    if (manifestTemporary) {
        rmSync(manifestTemporary, { force: true });
    }
}
