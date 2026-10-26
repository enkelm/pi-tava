import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { takeLock } from "../src/server/lock.ts";

function fixture(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "coop-lock-test-"));

    t.after(() => rmSync(dir, { recursive: true, force: true }));

    return join(dir, "harness.lock");
}

test("a second app in this process cannot replace its data-directory lock", (t) => {
    const file = fixture(t);
    const release = takeLock(file);
    const before = readFileSync(file);

    assert.throws(() => takeLock(file), /already running/);
    assert.deepEqual(readFileSync(file), before);
    release();
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.identity`), false);
});

test(
    "real simultaneous process contenders retain exactly one owner, then permit a clean transfer",
    { timeout: 10_000 },
    async (t) => {
        const file = fixture(t);
        const source = `
        import {takeLock} from ${JSON.stringify(new URL("../src/server/lock.ts", import.meta.url).href)};
        let release;
        process.on("message", command => {
            if (command === "stop") {
                release?.();
                process.disconnect();
                return;
            }
            if (command === "release") {
                release?.();
                release = undefined;
                process.send("released");
                return;
            }
            try {
                release = takeLock(process.argv[1]);
                process.send("acquired");
            } catch (error) {
                process.send("refused:" + error.message);
            }
        });
        process.send("ready");
    `;

        const create = () => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", source, file], {
                stdio: ["ignore", "ignore", "inherit", "ipc"],
            });
            const ready = once(child, "message");
            const closed = once(child, "close");

            const command = async (message: string) => {
                const reply = once(child, "message");

                child.send(message);

                const [result] = await reply;

                assert.equal(typeof result, "string");

                return result as string;
            };

            return { child, ready, closed, command };
        };

        const contenders = [create(), create()];

        t.after(async () => {
            for (const { child } of contenders) {
                if (child.connected) {
                    child.send("stop");
                }
            }

            for (const { closed } of contenders) {
                const [code, signal] = await closed;

                assert.equal(code, 0);
                assert.equal(signal, null);
            }
        });
        await Promise.all(contenders.map(({ ready }) => ready));
        const outcomes = await Promise.all(contenders.map(({ command }) => command("acquire")));

        assert.equal(outcomes.filter((value) => value === "acquired").length, 1);
        const winner = contenders[outcomes.indexOf("acquired")]!;
        const loser = contenders[outcomes.findIndex((value) => value.startsWith("refused:"))]!;
        const owned = readFileSync(file);

        assert.equal(owned.toString(), `${winner.child.pid}\n`);
        assert.match(await loser.command("acquire"), /already running/);
        assert.deepEqual(readFileSync(file), owned, "a real live holder is never replaced");
        await winner.command("release");
        assert.equal(existsSync(file), false);
        assert.equal(await loser.command("acquire"), "acquired");
        assert.equal(readFileSync(file, "utf8"), `${loser.child.pid}\n`);
    },
);

test(
    "Linux process-generation mismatch permits takeover without letting the old release remove it",
    { skip: process.platform !== "linux" },
    (t) => {
        const file = fixture(t);
        const releaseOld = takeLock(file);
        const saved = JSON.parse(readFileSync(`${file}.identity`, "utf8")) as {
            startTime?: string;
        };

        assert.ok(saved.startTime, "the real Linux kernel must supply process start-time evidence");
        saved.startTime = String(BigInt(saved.startTime) + 1n);
        writeFileSync(`${file}.identity`, JSON.stringify(saved));
        const releaseNew = takeLock(file);
        const replacement = readFileSync(`${file}.identity`);

        releaseOld();
        assert.deepEqual(readFileSync(`${file}.identity`), replacement);
        assert.equal(readFileSync(file, "utf8"), `${process.pid}\n`);
        releaseNew();
        assert.equal(existsSync(file), false);
    },
);

test("permission-denied liveness is not permission to take a legacy lock", (t) => {
    const file = fixture(t);
    const before = "1073741824\n";

    writeFileSync(file, before);
    t.mock.method(process, "kill", (_pid: number, signal: unknown) => {
        assert.equal(signal, 0);

        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    assert.throws(() => takeLock(file), /already running/);
    assert.equal(readFileSync(file, "utf8"), before);
});

test("only a proven dead legacy holder permits takeover", (t) => {
    const file = fixture(t);

    writeFileSync(file, "1073741824\n");
    t.mock.method(process, "kill", () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const release = takeLock(file);

    assert.equal(readFileSync(file, "utf8"), `${process.pid}\n`);
    release();
    release();
    assert.equal(existsSync(file), false);
});

test("an old cleanup cannot delete a replacement with the same pid", (t) => {
    const file = fixture(t);
    const release = takeLock(file);

    renameSync(file, `${file}.previous`);
    writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
    writeFileSync(`${file}.identity`, "replacement identity\n");
    release();
    assert.equal(readFileSync(file, "utf8"), `${process.pid}\n`);
    assert.equal(readFileSync(`${file}.identity`, "utf8"), "replacement identity\n");
});

for (const damaged of ["", "not a pid\n", "0\n", "2147483648\n", "9007199254740991\n"]) {
    test(`recent incomplete lock ${JSON.stringify(damaged)} is not stolen`, (t) => {
        const file = fixture(t);

        writeFileSync(file, damaged);
        assert.throws(() => takeLock(file), /incomplete|damaged/);
        assert.equal(readFileSync(file, "utf8"), damaged);
    });

    test(`stale damaged lock ${JSON.stringify(damaged)} can recover`, (t) => {
        const file = fixture(t);
        const old = new Date(Date.now() - 60_000);

        writeFileSync(file, damaged);
        utimesSync(file, old, old);
        const release = takeLock(file);

        assert.equal(readFileSync(file, "utf8"), `${process.pid}\n`);
        release();
        assert.equal(existsSync(file), false);
    });
}

test("a symbolic lock cannot redirect acquisition or cleanup to another file", (t) => {
    const file = fixture(t);
    const target = `${file}.target`;

    writeFileSync(target, "0\n");
    symlinkSync(target, file);
    assert.throws(() => takeLock(file), { code: "ELOOP" });
    assert.equal(readFileSync(target, "utf8"), "0\n");
    assert.equal(existsSync(file), true);
});

test("unbound identity metadata cannot authorize stealing a live legacy holder", (t) => {
    const file = fixture(t);

    writeFileSync(file, `${process.pid}\n`);
    writeFileSync(
        `${file}.identity`,
        JSON.stringify({ version: 1, pid: process.pid, fileId: "old generation", startTime: "0" }),
    );
    assert.throws(() => takeLock(file), /already running/);
    assert.equal(readFileSync(file, "utf8"), `${process.pid}\n`);
});
