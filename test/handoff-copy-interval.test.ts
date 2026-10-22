// Copy-interval control-flow regression, not native Git or confinement evidence.
import {
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HandoffsDoc } from "../src/server/workflow-docs.ts";
import { WorkspaceBackend } from "../src/server/workspace-backend.ts";

after(cleanUp);

// Model Git only; fingerprints, file copying, durable reservations and handoff admission stay real.
// The existing after-ready race does not catch a post-copy fingerprint accepting a new baseline.
test("modeled copy interval preserves the pre-copy source baseline and uncertain reservation", async (t) => {
    for (const change of ["none", "tracked", "untracked", "omitted"] as const) {
        await t.test(change, async (t) => {
            const repo = join(root, `modeled-copy-interval-${change}`);
            const cwd = join(repo, "app");
            const code = "export const answer = 2;\n";
            const notes = "untracked context\n";
            const head = "a".repeat(40);
            const common = join(repo, ".git");
            const huge = join(cwd, "oversize.bin");

            mkdirSync(cwd, { recursive: true });
            mkdirSync(common);
            writeFileSync(join(cwd, "code.ts"), code);
            writeFileSync(join(cwd, "notes.md"), notes);
            writeFileSync(huge, "");
            truncateSync(huge, 80 * 1024 * 1024);
            const results: { text: string; isError: boolean }[] = [];
            const model = scriptedModel((input) => {
                const last = lastText(input);

                if (
                    last.role === "user" &&
                    last.text.includes("/handoff worker --new --worktree")
                ) {
                    return fauxAssistantMessage(
                        [
                            fauxToolCall("handoff", {
                                action: "start",
                                targetType: "worker",
                                relationship: "new-work",
                                worktree: true,
                                summary:
                                    "Check the copy interval. No commits or restart authorized.",
                            }),
                        ],
                        { stopReason: "toolUse" },
                    );
                }

                if (last.role === "toolResult") {
                    const message = input.messages.at(-1)!;

                    results.push({
                        text: last.text,
                        isError: "isError" in message && message.isError === true,
                    });
                }

                return fauxAssistantMessage("Finished the modeled handoff request.");
            });
            const app = await openApp(model, join(root, `copy-interval-app-${change}`));
            const directories = new Set<string>();
            const envFor = app.envFor.bind(app);

            t.mock.method(app, "envFor", (...args: Parameters<typeof envFor>) => {
                const env = envFor(...args);
                const write = env.writeFile.bind(env);

                return new Proxy(env, {
                    get(target, property) {
                        return property === "writeFile"
                            ? (...args: Parameters<typeof write>) => {
                                  directories.add(dirname(args[0]));

                                  return write(...args);
                              }
                            : Reflect.get(target, property, target);
                    },
                });
            });

            try {
                const { id } = await app.commands.createSession(owner(app), {
                    cwd,
                    threadType: "worker",
                });

                await app.commands.configure(id, owner(app), {
                    model: { provider: "faux", modelId: "faux-1" },
                });
                const copy = WorkspaceBackend.prototype.copyFile;
                const checkouts = new Map<string, string>();
                let copied = false;

                t.mock.method(
                    WorkspaceBackend.prototype,
                    "gitBytes",
                    async (_cwd: string, args: string[]) => {
                        const current = realpathSync(_cwd);
                        const target = [...checkouts.keys()].find((path) => {
                            const canonical = realpathSync(path);

                            return current === canonical || current.startsWith(`${canonical}/`);
                        });
                        const base = target ?? repo;
                        const files = ["app/notes.md", "app/oversize.bin"].filter((path) =>
                            existsSync(join(base, path)),
                        );
                        let output: string;

                        if (args[0] === "rev-parse") {
                            output = args.includes("--show-toplevel")
                                ? base
                                : args.includes("--show-prefix")
                                  ? "app/"
                                  : args.includes("--git-common-dir")
                                    ? common
                                    : args.includes("--absolute-git-dir")
                                      ? common
                                      : head;
                        } else if (args[0] === "symbolic-ref") {
                            output = checkouts.get(base) ?? "main";
                        } else if (args[0] === "for-each-ref") {
                            output = [...checkouts.values()]
                                .filter((branch) => args.includes(`refs/heads/${branch}`))
                                .map((branch) => `refs/heads/${branch}\n`)
                                .join("");
                        } else if (args[0] === "worktree" && args[1] === "list") {
                            output = [repo, ...checkouts.keys()]
                                .map((path) => `worktree ${path}\0\0`)
                                .join("");
                        } else if (args[0] === "worktree" && args[1] === "add") {
                            const path = args.at(-2)!;

                            checkouts.set(path, args[3]!);
                            mkdirSync(join(path, "app"), { recursive: true });
                            output = "";
                        } else if (args[0] === "stash" && args[1] === "create") {
                            output = "b".repeat(40);
                        } else if (args[0] === "stash" && args[1] === "apply") {
                            copyFileSync(join(cwd, "code.ts"), join(base, "app/code.ts"));
                            output = "";
                        } else if (args[0] === "status") {
                            output = args.includes("--porcelain=v2")
                                ? ""
                                : ` M app/code.ts\0${files.map((path) => `?? ${path}\0`).join("")}`;
                        } else if (args[0] === "ls-files") {
                            output = args.includes("--stage")
                                ? `100644 ${head} 0\tapp/code.ts\0`
                                : args.includes("--others")
                                  ? files.map((path) => `${path}\0`).join("")
                                  : "app/code.ts\0";
                        } else {
                            throw new Error(`Unmodeled Git command: ${args.join(" ")}`);
                        }

                        return Buffer.from(output);
                    },
                );
                t.mock.method(
                    WorkspaceBackend.prototype,
                    "copyFile",
                    async function (this: WorkspaceBackend, ...args: Parameters<typeof copy>) {
                        await copy.apply(this, args);
                        assert.equal(args[0], join(cwd, "notes.md"));
                        copied = true;

                        if (change === "tracked") {
                            writeFileSync(join(cwd, "code.ts"), "export const answer = 3;\n");
                        } else if (change === "untracked") {
                            writeFileSync(join(cwd, "notes.md"), "external context!\n");
                        } else if (change === "omitted") {
                            truncateSync(huge, 81 * 1024 * 1024);
                        }
                    },
                );
                await say(
                    app,
                    id,
                    `/handoff worker --new --worktree Check modeled copy interval ${change}.`,
                );
                await until(() => !app.isBusy(id), "source copy-interval request settles");
                const doc = await app.harness.snapshot(HandoffsDoc, context);
                const transfers = Object.values(doc?.handoffs ?? {});

                // Settle a pre-fix stale successor too, so a failing regression leaves no background work.
                if (transfers[0] !== undefined) {
                    const record = transfers[0];

                    await until(async () => {
                        const saved = (await app.harness.snapshot(HandoffsDoc, context))?.handoffs[
                            record.id
                        ];

                        return (
                            saved?.delivery === "delivered" &&
                            !app.isBusy(record.targetThreadId as ConversationId)
                        );
                    }, "modeled successor settles");
                }

                assert.equal(copied, true, results[0]?.text ?? "No handoff result");
                assert.equal(results.length, 1);
                assert.equal(checkouts.size, 1);
                const [path] = [...checkouts.keys()];

                assert.equal(readFileSync(join(path!, "app/code.ts"), "utf8"), code);
                assert.equal(readFileSync(join(path!, "app/notes.md"), "utf8"), notes);
                assert.equal(existsSync(join(path!, "app/oversize.bin")), false);
                assert.equal(
                    readFileSync(join(cwd, "code.ts"), "utf8"),
                    change === "tracked" ? "export const answer = 3;\n" : code,
                );
                assert.equal(
                    readFileSync(join(cwd, "notes.md"), "utf8"),
                    change === "untracked" ? "external context!\n" : notes,
                );
                assert.equal(statSync(huge).size, (change === "omitted" ? 81 : 80) * 1024 * 1024);
                const setups = Object.values(doc?.worktrees ?? {});

                assert.equal(setups.length, 1);

                if (change === "none") {
                    assert.equal(results[0]!.isError, false, results[0]!.text);
                    assert.equal(setups[0]!.status, "ready");
                    assert.equal(transfers.length, 1);
                    assert.deepEqual(transfers[0]!.skippedFiles, ["app/oversize.bin"]);
                    assert.equal(app.workItems.isReadOnly(id), true);
                } else {
                    assert.equal(results[0]!.isError, true, results[0]!.text);
                    assert.match(results[0]!.text, /changed or uncertain/);
                    assert.equal(setups[0]!.status, "creating");
                    assert.equal(setups[0]!.worktree.path, path);
                    assert.equal(transfers.length, 0);
                    assert.equal(app.workItems.isReadOnly(id), false);
                }
            } finally {
                await app.close();

                for (const directory of directories) {
                    rmSync(directory, { recursive: true, force: true });
                }
            }
        });
    }
});
