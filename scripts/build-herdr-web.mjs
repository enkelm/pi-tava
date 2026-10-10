#!/usr/bin/env node
/** Build the pinned native Herdr JSONL helper without changing Rust defaults. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const native = path.join(root, "native", "herdr-web");
const args = process.argv.slice(2);

if (args.some((arg) => arg !== "--debug" && arg !== "--test")) {
    console.error("Usage: node scripts/build-herdr-web.mjs [--debug] [--test]");
    process.exit(2);
}

if (process.platform === "win32") {
    console.error("herdr-web requires Unix sockets; build on macOS or Linux.");
    process.exit(1);
}

const toolchain = process.env.HERDR_WEB_TOOLCHAIN || "1.96.0";
const common = [
    "--locked",
    "--manifest-path",
    path.join(native, "Cargo.toml"),
    "--target-dir",
    path.join(native, "target"),
];

function cargo(command, extra = []) {
    const result = spawnSync("cargo", [`+${toolchain}`, command, ...common, ...extra], {
        cwd: root,
        stdio: "inherit",
        // Do not discover a daemon, modify Rust defaults, or install anything.
        // An explicit target directory keeps the gateway's binary path stable.
        env: process.env,
    });

    if (result.error || result.status !== 0) {
        console.error(
            `herdr-web build failed. Install a named Rust toolchain if needed: rustup toolchain install ${toolchain} --profile minimal`,
        );
        process.exit(result.status || 1);
    }
}

if (args.includes("--test")) {
    cargo("test");
}

const debug = args.includes("--debug");

cargo("build", debug ? [] : ["--release"]);
console.log(path.join(native, "target", debug ? "debug" : "release", "herdr-web"));
