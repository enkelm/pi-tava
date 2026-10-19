// Offline policy and SSH wire-construction evidence only: no native sandbox or SSH service is run.
import assert from "node:assert/strict";
import { readFile, writeFile, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { mock, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { err, ExecutionError, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { protectSshEnv } from "../src/server/ssh-policy.ts";
import {
    withWorkflowPublicationLock,
    workflowExclusiveReason,
    createWorkflowEnv,
} from "../src/server/workflow-policy.ts";
import { sshFixture } from "./ssh-fixture.ts";
import { openApp, owner, scriptedModel } from "./helpers.ts";

// This peer deliberately refuses every command instead of executing a fake "sandbox".
// SFTP uses real fixture metadata and raw link bytes; command text is recorded at the SSH boundary.
const recordingPeer = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.SSH_TEST_ROOT;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'recorded'), JSON.stringify(argv) + '\n');
if (argv.at(-1) !== 'sftp') {
    process.stderr.write('Fixture refuses native launch');
    process.exit(78);
}
const uint = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const long = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = s => { const b = Buffer.from(s); return Buffer.concat([uint(b.length), b]); };
const send = p => process.stdout.write(Buffer.concat([uint(p.length), p]));
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
        const n = buffer.readUInt32BE(); const p = buffer.subarray(4, n + 4); buffer = buffer.subarray(n + 4);
        if (p[0] === 1) { send(Buffer.concat([Buffer.from([2]), uint(3)])); continue; }
        const id = p.subarray(1, 5); const length = p.readUInt32BE(5); const target = p.subarray(9, 9 + length).toString();
        if (p[0] === 7) {
            const s = fs.lstatSync(target);
            send(Buffer.concat([Buffer.from([105]), id, uint(1|4|8), long(s.size), uint(s.mode), uint(0), uint(0)]));
        } else if (p[0] === 19) {
            send(Buffer.concat([Buffer.from([104]), id, uint(1), str(fs.readlinkSync(target, {encoding:'buffer'})), str(''), uint(0)]));
        } else {
            send(Buffer.concat([Buffer.from([101]), id, uint(8), str('unsupported'), str('')]));
        }
    }
});
`;

function decodeShellWord(word: string): string {
    // The fixed transport uses POSIX single-quoted words, with escaped apostrophes between them.
    assert.ok(word.startsWith("'") && word.endsWith("'"));

    return word.slice(1, -1).replaceAll("'\\''", "'");
}

async function recorder() {
    const f = await sshFixture();

    await writeFile(join(f.root, "bin", "ssh"), recordingPeer, { mode: 0o755 });

    return f;
}

test("managed SSH confines the workload environment and preserves rejected launch without raw replay", async () => {
    const f = await recorder();

    try {
        let output = "";
        const value = "value' ; $(touch never)\n雪";
        const result = getOrThrow(
            await f.env.execConfined(
                true,
                ["printf", "%s", value],
                {
                    env: { BASH_ENV: "/untrusted/startup", COOP_VALUE: value },
                    onOutput: (text) => {
                        output += text;
                    },
                },
                context,
            ),
        );

        assert.equal(result.exitCode, 78);
        assert.equal(output, "Fixture refuses native launch");
        const calls = (await readFile(join(f.root, "recorded"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]);
        const commands = calls.filter((args) => args.at(-1) !== "sftp");

        assert.equal(commands.length, 1, "rejected native launch must not retry unrestricted");
        const remote = commands[0]!.at(-1)!;
        const prefix = '/usr/bin/env -i PATH="$PATH" HOME="$HOME" /bin/bash --noprofile --norc -c ';

        assert.ok(remote.startsWith(prefix));
        const supervisor = decodeShellWord(remote.slice(prefix.length));
        const native = supervisor.indexOf("/usr/bin/sandbox-exec -p ");
        const environment = supervisor.indexOf("BASH_ENV=");

        assert.ok(native >= 0 && environment > native);
        assert.ok(!supervisor.slice(0, native).includes("/untrusted/startup"));
        assert.match(supervisor, /\/usr\/bin\/uname -s/);
        assert.match(supervisor, /\(deny network\*\)/);
        assert.match(supervisor, /\(deny mach-lookup\)/);
        assert.match(supervisor, /\(deny file-write\*\)/);
        assert.match(supervisor, /\(deny signal\)/);
        assert.ok(supervisor.includes("/usr/bin/env BASH_ENV="));
        assert.ok(supervisor.includes("/bin/bash --noprofile --norc -c"));
        assert.ok(!supervisor.slice(0, native).includes(value));
        const bodyPrefix = " /bin/bash --noprofile --norc -c ";
        const bodyAt = supervisor.indexOf(bodyPrefix, native) + bodyPrefix.length;
        const bodyEnd = supervisor.indexOf(" </dev/null &\n", bodyAt);
        const body = decodeShellWord(supervisor.slice(bodyAt, bodyEnd));
        const argument = body.slice(
            body.lastIndexOf("exec 'printf' '%s' ") + "exec 'printf' '%s' ".length,
        );

        assert.equal(
            decodeShellWord(argument),
            value,
            "managed argv survives nested shell quoting",
        );
        assert.ok(body.includes("/Library/Developer/CommandLineTools/usr/bin/git"));
    } finally {
        await f.env.cleanup(context);
        await f.close();
    }
});

test("trusted SFTP inspection returns lstat mode and byte-exact symlink targets", async () => {
    const f = await recorder();

    try {
        const path = join(f.root, "target");
        const link = join(f.root, "link");
        const target = Buffer.from([0x66, 0x6f, 0x80, 0x27, 0x0a]);

        await writeFile(path, "content");
        await chmod(path, 0o640);
        await symlink(target, link);
        assert.equal(getOrThrow(await f.env.lstat(path, context)).mode & 0o777, 0o640);
        assert.equal(getOrThrow(await f.env.lstat(link, context)).kind, "symlink");
        assert.deepEqual(Buffer.from(getOrThrow(await f.env.readlink(link, context))), target);
    } finally {
        await f.env.cleanup(context);
        await f.close();
    }
});

test("cached SSH environment uses live workflow authority, inspection mode and in-flight write reservations", async () => {
    const f = await sshFixture();
    const app = await openApp(scriptedModel(), join(f.root, "app"));
    const patches: { mock: { restore(): void } }[] = [];

    try {
        const { id } = await app.commands.createSession(owner(app), {
            cwd: f.root,
            threadType: "worker",
        });
        let requester: string | undefined = owner(app).id;
        let readOnly = false;
        let calls = 0;
        let mode: boolean | undefined;
        let finish: (() => void) | undefined;

        patches.push(mock.method(app.attribution, "requesterOf", () => requester));
        patches.push(mock.method(app.handoffs, "isReadOnly", () => readOnly));
        patches.push(
            mock.method(f.env, "execConfined", async (inspection: boolean) => {
                calls++;
                mode = inspection;

                if (finish !== undefined) {
                    await new Promise<void>((resolve) => {
                        finish = resolve;
                    });
                }

                return err(
                    new ExecutionError("shell_unavailable", "fixture native confinement rejected"),
                );
            }),
        );
        const env = protectSshEnv(app, id, f.env);

        assert.equal(Reflect.get(env, "execConfined"), undefined);
        assert.equal((await env.exec("printf ok", undefined, context)).ok, false);
        assert.equal(mode, false);
        assert.equal(calls, 1, "confinement failure must not run ordinary remote exec");
        assert.equal((await env.exec("git push origin HEAD", undefined, context)).ok, false);
        assert.equal(calls, 1, "publication spelling blocked before transport");
        const local = createWorkflowEnv(app, id, f.root);

        assert.equal(
            (await local.exec([], undefined, context)).ok,
            false,
            "empty argv never launches a native sandbox or env printer",
        );
        readOnly = true;
        assert.equal((await env.exec("bash -c 'printf ok'", undefined, context)).ok, false);
        assert.equal(calls, 1, "retired shell rejects commands outside simple inspection");
        await env.exec("pwd", undefined, context);
        assert.equal(mode, true);
        assert.equal((await env.writeFile("retired", "no", context)).ok, false);
        readOnly = false;
        requester = undefined;
        assert.equal((await env.readTextFile("AGENTS.md", context)).ok, false);
        assert.equal((await env.exec("pwd", undefined, context)).ok, false);
        // Explicit readers use their own current visibility/token, not stale agent attribution.
        const viewer = app.config.addUser("Scoped reader", "viewer", [String(id)]).user;
        const reader = protectSshEnv(app, id, f.env, viewer);
        const localReader = createWorkflowEnv(app, id, f.root, viewer);

        await writeFile(join(f.root, "visible.txt"), "visible to this reader");

        for (const bound of [reader, localReader]) {
            assert.equal(
                getOrThrow(await bound.readTextFile("visible.txt", context)),
                "visible to this reader",
            );
            assert.equal((await bound.exec("pwd", undefined, context)).ok, false);
            assert.equal((await bound.writeFile("viewer-write", "no", context)).ok, false);
        }

        app.config.updateUser(viewer.id, { sessions: [] });
        assert.equal((await reader.readTextFile("visible.txt", context)).ok, false);
        app.config.updateUser(viewer.id, { sessions: [String(id)] });
        viewer.tokenHash = "fixture rotated token";
        assert.equal((await reader.readTextFile("visible.txt", context)).ok, false);
        const human = protectSshEnv(app, id, f.env, owner(app));

        await human.exec("pwd", undefined, context);
        assert.equal(mode, false, "explicit steering requester works without agent attribution");
        requester = owner(app).id;

        finish = () => {};

        const running = env.exec("pwd", undefined, context);

        assert.match(workflowExclusiveReason(app, id) ?? "", /writes are still executing/);
        await assert.rejects(
            withWorkflowPublicationLock(app, id, async () => {}),
            /writes are still executing/,
        );
        finish();
        await running;
        assert.equal(workflowExclusiveReason(app, id), undefined);
        await withWorkflowPublicationLock(app, id, async () => {
            assert.equal((await env.writeFile("locked", "no", context)).ok, false);
        });
        // A still-cached wrapper follows live Chat semantics; ordinary execution is not confined.
        patches.push(mock.method(app.handoffs, "isManaged", () => false));
        patches.push(mock.method(f.env, "exec", async () => ok({ exitCode: 9 })));
        assert.equal(getOrThrow(await env.exec("ordinary chat", undefined, context)).exitCode, 9);
    } finally {
        for (const patch of patches.reverse()) {
            patch.mock.restore();
        }

        await app.close();
        await f.env.cleanup(context);
        await f.close();
    }
});
