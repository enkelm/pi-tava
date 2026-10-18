import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import * as vm from "node:vm";

const origin = "https://coop.example";
const session = "a".repeat(32);
const secret = "PRIVATE_TERMINAL_SENTINEL_7a13";
const compiled = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const source = await readFile(
    new URL("../native/herdr-renderer/renderer.js", import.meta.url),
    "utf8",
);

type Message = Record<string, unknown>;
type Call = { type: string; sequence: number; payload?: string };

// Execute the shipped child, not a copy of its loader. GPUI 0.3.6 app.rs documents that
// Application::run returns immediately on WASM; platform.rs awaits initialize_graphics
// before invoking the launch callback. The bindings stub only supplies that async boundary.
async function child(options: { deferInitialization?: boolean; startThrows?: boolean } = {}) {
    const listeners = new Map<string, (event: unknown) => void>();
    const messages: Message[] = [];
    const calls: Call[] = [];
    const fetches: unknown[][] = [];
    const initializations: unknown[] = [];
    const initialization = Promise.withResolvers<void>();
    let onPainted: ((sequence: number) => void) | undefined;
    let onReady: (() => void) | undefined;
    let onError: ((error: unknown) => void) | undefined;
    let started = 0;
    let sceneReady = false;
    let observing = false;
    let mutation: ((records: { addedNodes: Paragraph[] }[]) => void) | undefined;
    const parent = {
        postMessage(message: Message, target: string) {
            assert.equal(target, origin);
            messages.push(structuredClone(message));
        },
    };
    const window = {
        addEventListener(type: string, listener: (event: unknown) => void) {
            listeners.set(type, listener);
        },
    };

    class Paragraph {
        textContent = `Failed to initialize browser graphics: ${secret}`;
        removed = false;
        remove() {
            this.removed = true;
        }
    }

    const context = vm.createContext({
        location: { origin, hash: `#${session}` },
        parent,
        window,
        document: { body: {} },
        WebAssembly,
        HTMLParagraphElement: Paragraph,
        MutationObserver: class {
            constructor(callback: typeof mutation) {
                mutation = callback;
            }
            observe() {
                observing = true;
            }
            disconnect() {
                observing = false;
            }
        },
        // Legacy-loader support lets the readiness regression fail on the original code
        // for premature ready, rather than failing incidentally at its old fetch call.
        fetch: async (...args: unknown[]) => {
            fetches.push(args);

            return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
        },
    });
    const bindings = new vm.SyntheticModule(
        ["default", "start", "present", "clear"],
        function () {
            this.setExport("default", async (argument: { module_or_path: unknown }) => {
                initializations.push(argument.module_or_path);
                await initialization.promise;
            });
            this.setExport(
                "start",
                (painted: typeof onPainted, ready: typeof onReady, error: typeof onError) => {
                    started++;

                    if (options.startThrows) {
                        throw new Error(secret);
                    }

                    onPainted = painted;
                    onReady = ready;
                    onError = error;
                    // Deliberately return before the scene exists, as the real platform does.
                },
            );
            this.setExport("present", (payload: string, sequence: number) => {
                calls.push({ type: "present", sequence, payload });
                assert.ok(sceneReady, "present must not precede asynchronous scene creation");
            });
            this.setExport("clear", (sequence: number) => {
                calls.push({ type: "clear", sequence });
                assert.ok(sceneReady, "clear must not precede asynchronous scene creation");
            });
        },
        { context },
    );

    await bindings.link(() => assert.fail("The bindings stub has no dependencies"));
    await bindings.evaluate();

    const script = new vm.SourceTextModule(source, {
        context,
        importModuleDynamically: async (specifier) => {
            assert.equal(specifier, "./pkg/herdr_renderer.js");

            return bindings;
        },
    });

    await script.link(() => assert.fail("The child has no static dependencies"));
    await script.evaluate();

    if (!options.deferInitialization) {
        initialization.resolve();
    }

    const receive = (data: Message, sender = parent, senderOrigin = origin) =>
        listeners.get("message")?.({ source: sender, origin: senderOrigin, data });
    const bootstrap = () => receive({ type: "gpui-bootstrap", session, module: compiled });
    const command = (type: "gpui-present" | "gpui-clear", sequence = 1) =>
        receive({ type, session, sequence, fence: "epoch-1", payload: secret });

    await setImmediate();

    return {
        messages,
        calls,
        fetches,
        initializations,
        initialization,
        receive,
        bootstrap,
        command,
        started: () => started,
        finishLaunch() {
            sceneReady = true;
            onReady?.();
        },
        painted: (sequence: number) => onPainted?.(sequence),
        failLaunch: () => onError?.(new Error(secret)),
        dispatch: (type: string) => listeners.get(type)?.({ message: secret, reason: secret }),
        graphicsFailure() {
            const paragraph = new Paragraph();

            if (observing) {
                mutation?.([{ addedNodes: [paragraph] }]);
            }

            return paragraph;
        },
        observing: () => observing,
    };
}

if (typeof vm.SourceTextModule !== "function") {
    // npm test does not enable VM modules. Keep this socket-free suite in its own process,
    // with the same test runner, and surface the child's complete failure diagnostics.
    test("paint-child scheduling and bootstrap contracts", () => {
        const result = spawnSync(
            process.execPath,
            ["--experimental-vm-modules", "--test", import.meta.filename],
            { encoding: "utf8", timeout: 30_000 },
        );

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
} else {
    test("the actual child waits for asynchronous scene readiness before commands or ready", async () => {
        const f = await child();

        f.bootstrap();
        await setImmediate();
        assert.equal(f.started(), 1);
        assert.deepEqual(
            f.messages.filter((message) => message.type === "gpui-ready"),
            [],
            "returning from wasm.start is not asynchronous scene readiness",
        );
        f.command("gpui-present");
        f.command("gpui-clear");
        assert.deepEqual(f.calls, [], "early commands cannot reach an uncreated scene");
        assert.equal(f.messages[0]?.type, "gpui-bootstrap");
        assert.deepEqual(f.fetches, [], "only the parent downloads WASM");
        assert.equal(f.initializations.length, 1);
        assert.equal(f.initializations[0], compiled);

        f.finishLaunch();
        f.finishLaunch();
        assert.equal(f.messages.filter((message) => message.type === "gpui-ready").length, 1);
        f.command("gpui-present", 2);
        assert.deepEqual(f.calls, [{ type: "present", sequence: 2, payload: secret }]);
        assert.equal(f.messages.filter((message) => message.type === "gpui-painted").length, 0);
        f.painted(1);
        f.painted(2);
        assert.deepEqual(f.messages.at(-1), {
            type: "gpui-painted",
            session,
            sequence: 2,
            fence: "epoch-1",
        });
        f.command("gpui-clear", 3);
        f.painted(2);
        f.painted(3);
        assert.deepEqual(f.calls.at(-1), { type: "clear", sequence: 3 });
        assert.deepEqual(f.messages.at(-1), {
            type: "gpui-painted",
            session,
            sequence: 3,
            fence: "epoch-1",
        });
    });

    test("bootstrap accepts only the exact parent, origin, session and compiled Module", async () => {
        const f = await child();
        const data = { type: "gpui-bootstrap", session, module: compiled };

        f.receive(data, { postMessage() {} });
        f.receive(data, undefined, "https://foreign.example");
        f.receive({ ...data, session: "b".repeat(32) });
        f.command("gpui-present");
        await setImmediate();
        assert.deepEqual(f.initializations, []);
        assert.deepEqual(f.calls, []);
        f.bootstrap();
        await setImmediate();
        assert.deepEqual(f.initializations, [compiled]);
        f.receive({ ...data, module: new ArrayBuffer(8) });
        await setImmediate();
        assert.deepEqual(f.initializations, [compiled], "duplicate bootstrap cannot restart WASM");
        f.finishLaunch();
        assert.equal(f.messages.at(-1)?.type, "gpui-ready");

        const invalid = await child();

        invalid.receive({ ...data, module: new ArrayBuffer(8) });
        await setImmediate();
        assert.deepEqual(invalid.initializations, []);
        assert.deepEqual(invalid.messages.at(-1), {
            type: "gpui-error",
            session,
            message: "Terminal renderer unavailable.",
        });
    });

    test("asynchronous launch, graphics and synchronous failures redact and retire the child", async (t) => {
        for (const mode of ["launch", "graphics", "error", "unhandledrejection", "start", "init"]) {
            await t.test(mode, async () => {
                const f = await child({
                    startThrows: mode === "start",
                    deferInitialization: mode === "init",
                });

                f.bootstrap();
                await setImmediate();

                if (mode === "init") {
                    f.initialization.reject(new Error(secret));
                    await setImmediate();
                } else if (mode === "launch") {
                    f.failLaunch();
                } else if (mode === "graphics") {
                    assert.equal(f.graphicsFailure().removed, true);
                } else if (mode !== "start") {
                    f.dispatch(mode);
                }

                f.finishLaunch();
                f.command("gpui-present");
                f.command("gpui-clear");
                f.painted(1);
                f.dispatch("error");
                assert.deepEqual(f.calls, []);
                assert.deepEqual(
                    f.messages.filter((message) => message.type !== "gpui-bootstrap"),
                    [{ type: "gpui-error", session, message: "Terminal renderer unavailable." }],
                );
                assert.equal(JSON.stringify(f.messages).includes(secret), false);
            });
        }
    });

    test("disposal ignores late bootstrap, initialization, readiness and paint callbacks", async (t) => {
        for (const stage of ["bootstrap", "initialization", "launch", "paint"]) {
            await t.test(stage, async () => {
                const f = await child({ deferInitialization: stage === "initialization" });

                if (stage !== "bootstrap") {
                    f.bootstrap();
                    await setImmediate();
                }

                if (stage === "paint") {
                    f.finishLaunch();
                    f.command("gpui-present");
                }

                f.dispatch("pagehide");
                const before = structuredClone(f.messages);
                const callsBefore = structuredClone(f.calls);

                f.bootstrap();
                f.initialization.resolve();
                await setImmediate();
                f.finishLaunch();
                f.failLaunch();
                f.painted(1);
                f.command("gpui-clear");
                f.dispatch("error");
                assert.deepEqual(f.messages, before);
                assert.deepEqual(f.calls, callsBefore);
                assert.equal(f.observing(), false);

                if (stage === "bootstrap" || stage === "initialization") {
                    assert.equal(f.started(), 0, "disposal must not start a deferred GPU window");
                }
            });
        }
    });
}
