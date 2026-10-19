import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
    createSshPassword,
    SshPasswords,
    type SshPasswordLease,
} from "../src/server/ssh-passwords.ts";

// These tests own the actual askpass child/FIFO boundary and the ephemeral
// credential lifecycle. No SSH server, owner configuration or real password is used.
async function fixture(t: TestContext, password: string) {
    const credential = createSshPassword(password);

    t.after(() => credential.dispose());

    const lease = await credential.prepare();

    t.after(() => lease.close());
    lease.authorize(process.pid);

    return { credential, lease };
}

async function runChild(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onStderr?: (text: string) => void,
) {
    const child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

    child.stdout.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => {
        const text = data.toString("utf8");

        stderr += text;
        onStderr?.(text);
    });

    try {
        const result = await new Promise<{ code: number | null; signal: string | null }>(
            (resolve, reject) => {
                child.on("error", reject);
                child.on("close", (code, signal) => resolve({ code, signal }));
            },
        );

        assert.equal(result.signal, null, "askpass must finish without waiting for more FIFO data");

        return { ...result, stdout, stderr, argv: child.spawnargs };
    } finally {
        clearTimeout(timer);
    }
}

async function askpass(lease: SshPasswordLease, prompt: string, overrides: NodeJS.ProcessEnv = {}) {
    return runChild(lease.env.SSH_ASKPASS!, [prompt], { ...lease.env, ...overrides });
}

test("one-use askpass delivers literal Unicode and shell characters without storing them in files, env or argv", async (t) => {
    const password = "literal ' \" $() ` ; & | < > \\ 雪🙂";
    const { credential, lease } = await fixture(t, password);
    const directory = dirname(lease.env.SSH_ASKPASS!);
    const paths = await readdir(directory);

    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal(paths.length, 3);
    assert.equal(credential.wasPrompted(), false);
    assert.equal(
        Object.values(lease.env).some((value) => value?.includes(password)),
        false,
    );
    assert.equal(JSON.stringify(credential).includes(JSON.stringify(password).slice(1, -1)), false);

    let fifoCount = 0;

    for (const name of paths) {
        const path = join(directory, name);
        const info = await lstat(path);

        if (info.isFIFO()) {
            fifoCount++;
            assert.equal(info.mode & 0o777, 0o600);
        } else {
            assert.equal(info.isFile(), true);
            assert.equal(info.mode & 0o777, path === lease.env.SSH_ASKPASS ? 0o700 : 0o600);
            assert.equal((await readFile(path)).includes(Buffer.from(password)), false);
        }
    }

    assert.equal(fifoCount, 1);

    const first = await askpass(lease, "owner@devbox's password: ");

    assert.equal(first.code, 0);
    assert.equal(first.stdout, `${password}\n`);
    assert.equal(first.stderr, "");
    assert.equal(
        first.argv.some((arg) => arg.includes(password)),
        false,
    );

    const second = await askpass(lease, "Password:");

    assert.equal(second.code, 1);
    assert.equal(second.stdout, "");
    assert.equal(second.stderr, "");

    // A second operation gets an independent channel, not a refill of the old one.
    const nextLease = await credential.prepare();

    t.after(() => nextLease.close());
    nextLease.authorize(process.pid);
    assert.notEqual(nextLease.env.PI_COOP_SSH_PASSWORD_FIFO, lease.env.PI_COOP_SSH_PASSWORD_FIFO);
    assert.equal((await askpass(nextLease, "(owner@devbox) Password:")).stdout, `${password}\n`);
    const marker = lease.env.PI_COOP_SSH_PASSWORD_USED!;

    assert.equal((await lstat(marker)).mode & 0o777, 0o600);
    assert.equal(await readFile(marker, "utf8"), "1\n");
    await lease.close();
    await lease.close();
    assert.equal(credential.wasPrompted(), true);
    assert.throws(() => lease.authorize(process.pid), /Cannot authorize/);
    await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("askpass refuses confirmation, passphrase, OTP and password-change prompts without consuming the login password", async (t) => {
    const password = "disposable-login-password";
    const { credential, lease } = await fixture(t, password);
    const refused = [
        "New password:",
        "Retype new password:",
        "Change password:",
        "Current password:",
        "Enter passphrase for key '/tmp/key':",
        "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
        "Verification code:",
        "One-time password:",
        "Password (OTP):",
        "Password:\nNew password:",
        "devbox's password:",
    ];

    for (const prompt of refused) {
        const result = await askpass(lease, prompt);

        assert.equal(result.code, 1, prompt);
        assert.equal(result.stdout, "", prompt);
        assert.equal(result.stderr, "", prompt);
    }

    const confirmation = await askpass(lease, "Password:", { SSH_ASKPASS_PROMPT: "confirm" });

    assert.equal(confirmation.code, 1);
    assert.equal(confirmation.stdout, "");
    assert.equal(confirmation.stderr, "");
    assert.equal(credential.wasPrompted(), false);
    await assert.rejects(lstat(lease.env.PI_COOP_SSH_PASSWORD_USED!), { code: "ENOENT" });
    assert.equal((await askpass(lease, "Password:")).stdout, `${password}\n`);
});

test("askpass rejects regular-file, symlink, insecure-mode and missing IPC channels", async (t) => {
    const { lease } = await fixture(t, "private-fixture-password");
    const directory = await mkdtemp(join(tmpdir(), "coop-askpass-invalid-"));
    const regular = join(directory, "regular");
    const link = join(directory, "link");

    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(regular, "not-a-real-password\n", { mode: 0o600 });
    await symlink(lease.env.PI_COOP_SSH_PASSWORD_FIFO!, link);

    for (const path of [regular, link, undefined]) {
        const result = await askpass(lease, "Password:", { PI_COOP_SSH_PASSWORD_FIFO: path });

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
    }

    const fifo = lease.env.PI_COOP_SSH_PASSWORD_FIFO!;

    await chmod(fifo, 0o644);

    const insecure = await askpass(lease, "Password:");

    assert.equal(insecure.code, 1);
    assert.equal(insecure.stdout, "");
    assert.equal(insecure.stderr, "");
    await chmod(fifo, 0o600);
    assert.equal((await askpass(lease, "Password:")).stdout, "private-fixture-password\n");
});

test("inherited askpass in a proxy SSH child cannot consume the target password", async (t) => {
    const password = "target-only-fixture-password";
    const { credential, lease } = await fixture(t, password);

    assert.throws(() => lease.authorize(process.pid + 1), { code: "EEXIST" });

    const script = `
        import { spawnSync } from "node:child_process";
        const child = spawnSync(process.env.SSH_ASKPASS, ["jump@proxy's password: "], {
            env: process.env, encoding: "utf8", timeout: 2000,
        });
        process.stdout.write(child.stdout ?? "");
        process.stderr.write(child.stderr ?? "");
        process.exitCode = child.status ?? 1;
    `;
    const proxy = await runChild(
        process.execPath,
        ["--input-type=module", "-e", script],
        lease.env,
    );

    assert.equal(proxy.code, 1);
    assert.equal(proxy.stdout, "");
    assert.equal(proxy.stderr, "");
    assert.equal(credential.wasPrompted(), false);
    await assert.rejects(lstat(lease.env.PI_COOP_SSH_PASSWORD_USED!), { code: "ENOENT" });

    const direct = await askpass(lease, "owner@target's password: ");

    assert.equal(direct.code, 0);
    assert.equal(direct.stdout, `${password}\n`);
    await lease.close();
    assert.equal(credential.wasPrompted(), true);
});

test("askpass rejects unsafe or mismatched parent metadata without recording a password prompt", async (t) => {
    const { credential, lease } = await fixture(t, "metadata-fixture-password");
    const directory = await mkdtemp(join(tmpdir(), "coop-askpass-parents-"));
    const wrong = join(directory, "wrong");
    const link = join(directory, "link");
    const insecure = join(directory, "insecure");
    const oversize = join(directory, "oversize");
    const missing = join(directory, "missing");

    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(wrong, `${process.pid + 1}\n`, { mode: 0o600 });
    await symlink(lease.env.PI_COOP_SSH_PASSWORD_PARENT!, link);
    await writeFile(insecure, `${process.pid}\n`, { mode: 0o644 });
    await writeFile(oversize, "1".repeat(32), { mode: 0o600 });

    for (const path of [
        wrong,
        link,
        insecure,
        oversize,
        missing,
        lease.env.PI_COOP_SSH_PASSWORD_FIFO,
        undefined,
    ]) {
        const result = await askpass(lease, "Password:", { PI_COOP_SSH_PASSWORD_PARENT: path });

        assert.equal(result.code, 1);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
    }

    await lease.close();
    assert.equal(credential.wasPrompted(), false);

    // Merely preparing and binding a child is not proof it used the password.
    const unused = await credential.prepare();

    unused.authorize(process.pid);
    await unused.close();
    assert.equal(credential.wasPrompted(), false);
});

test("askpass briefly waits for its parent's PID authorization to be published", async (t) => {
    const credential = createSshPassword("delayed-parent-fixture-password");
    const lease = await credential.prepare();
    const helper = new URL("../src/server/ssh-askpass.ts", import.meta.url).href;
    const script = `process.stderr.write("ready\\n"); await import(${JSON.stringify(helper)});`;
    let timer: ReturnType<typeof setTimeout> | undefined;

    t.after(() => credential.dispose());
    t.after(() => lease.close());
    t.after(() => clearTimeout(timer));

    const result = await runChild(
        process.execPath,
        ["--input-type=module", "-e", script, "askpass", "Password:"],
        lease.env,
        () => {
            timer ??= setTimeout(() => lease.authorize(process.pid), 40);
        },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "ready\n");
    assert.equal(result.stdout, "delayed-parent-fixture-password\n");
    await lease.close();
    assert.equal(credential.wasPrompted(), true);
});

test("password validation rejects multiline/empty/oversize input and accepts exactly 1024 UTF-8 bytes", async (t) => {
    for (const password of [
        "",
        "secret\0suffix",
        "secret\r",
        "secret\n",
        "x".repeat(1025),
        "雪".repeat(342),
    ]) {
        assert.throws(() => createSshPassword(password), /1–1024 UTF-8 bytes/);
    }

    const password = "é".repeat(512);
    const { lease } = await fixture(t, password);
    const result = await askpass(lease, "Password:");

    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${password}\n`);
});

test("disposal revokes future preparation and closes active FIFO leases idempotently", async (t) => {
    const { credential, lease } = await fixture(t, "revoked-fixture-password");
    const directory = dirname(lease.env.SSH_ASKPASS!);

    credential.dispose();
    credential.dispose();
    await assert.rejects(credential.prepare(), /no longer available/);
    await lease.close();
    await assert.rejects(lstat(directory), { code: "ENOENT" });

    const pending = createSshPassword("pending-fixture-password");
    const prepare = pending.prepare();

    pending.dispose();
    await assert.rejects(prepare, /Cannot prepare SSH password login/);
});

test("status never extends idle expiry and actual lookups cannot extend the eight-hour absolute cap", async (t) => {
    const minute = 60 * 1000;
    const start = 10_000;
    const passwords = new SshPasswords();

    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
    t.after(() => passwords.close());

    const idle = passwords.set("scope", "idle", "idle-fixture-password");

    t.mock.timers.tick(29 * minute);
    assert.deepEqual(passwords.status("scope", "idle"), {
        authenticated: true,
        expiresAt: start + 30 * minute,
        expiresInMs: minute,
    });
    t.mock.timers.tick(minute);
    assert.deepEqual(passwords.status("scope", "idle"), { authenticated: false });
    await assert.rejects(idle.prepare(), /no longer available/);

    const activeStart = Date.now();
    const active = passwords.set("scope", "active", createSshPassword("active-fixture-password"));

    for (let i = 0; i < 23; i++) {
        t.mock.timers.tick(20 * minute);
        assert.equal(passwords.get("scope", "active"), active);
    }

    assert.deepEqual(passwords.status("scope", "active"), {
        authenticated: true,
        expiresAt: activeStart + 8 * 60 * minute,
        expiresInMs: 20 * minute,
    });
    t.mock.timers.tick(19 * minute);
    assert.equal(passwords.status("scope", "active").authenticated, true);
    t.mock.timers.tick(minute);
    assert.equal(passwords.get("scope", "active"), undefined);
    await assert.rejects(active.prepare(), /no longer available/);
});

test("published credentials are exact-person/destination isolated and revoked on replacement, logout and close", async (t) => {
    const passwords = new SshPasswords();
    const scopeA = JSON.stringify(["person", "token-a"]);
    const scopeB = JSON.stringify(["person", "token-b"]);
    const old = passwords.set(scopeA, "devbox", createSshPassword("old-fixture-password"));
    const replacement = createSshPassword("replacement-fixture-password");
    const otherHost = passwords.set(scopeA, "prod", "other-host-fixture-password");
    const otherScope = passwords.set(scopeB, "devbox", "other-scope-fixture-password");

    t.after(() => passwords.close());
    assert.equal(passwords.set(scopeA, "devbox", replacement), replacement);
    await assert.rejects(old.prepare(), /no longer available/);
    assert.equal(passwords.get(scopeA, "devbox"), replacement);
    assert.equal(passwords.get(scopeB, "devbox"), otherScope);
    assert.equal(passwords.get(scopeA, "devbox "), undefined);
    passwords.forget(scopeA, "devbox");
    await assert.rejects(replacement.prepare(), /no longer available/);
    assert.equal(passwords.get(scopeA, "prod"), otherHost);
    passwords.forgetUser(scopeA);
    await assert.rejects(otherHost.prepare(), /no longer available/);
    assert.deepEqual(passwords.status(scopeA, "prod"), { authenticated: false });
    assert.equal(passwords.get(scopeB, "devbox"), otherScope);
    passwords.close();
    passwords.close();
    await assert.rejects(otherScope.prepare(), /no longer available/);

    const late = createSshPassword("late-fixture-password");

    assert.throws(() => passwords.set(scopeB, "devbox", late), /closed/);
    await assert.rejects(late.prepare(), /no longer available/);
});

test("the 32-entry bound evicts the least recently used credential and revokes it", async (t) => {
    const passwords = new SshPasswords();
    const entries = Array.from({ length: 32 }, (_, i) =>
        passwords.set("scope", `host-${i}`, `fixture-password-${i}`),
    );

    t.after(() => passwords.close());
    assert.equal(passwords.get("scope", "host-0"), entries[0]);
    passwords.set("scope", "host-32", "fixture-password-32");
    assert.equal(passwords.get("scope", "host-0"), entries[0]);
    assert.equal(passwords.get("scope", "host-1"), undefined);
    await assert.rejects(entries[1]!.prepare(), /no longer available/);
    assert.equal(passwords.status("scope", "host-32").authenticated, true);
});
