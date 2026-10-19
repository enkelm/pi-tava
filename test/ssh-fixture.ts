// Shared disposable process/protocol boundary for transport and password-login integration tests.
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshExecutionEnv } from "../src/server/ssh-env.ts";

export const fixturePassword = "fixture-pass'雪$not-a-command";

// A disposable SSH executable speaks the external SFTP v3 protocol against fixture files,
// or runs the supplied remote command in a real shell. No SSH service or credentials.
const peer = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const root = process.env.SSH_TEST_ROOT;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(argv)+'\n');
if (process.env.SSH_TEST_REQUIRE_PASSWORD === '1') {
    const expected = ${JSON.stringify(fixturePassword)};
    if (!argv.includes('-oBatchMode=no') || !argv.includes('-oStrictHostKeyChecking=yes') || !argv.includes('-oControlPath=none') || !process.env.SSH_ASKPASS || JSON.stringify(process.env).includes(expected) || JSON.stringify(argv).includes(expected)) { process.stderr.write('Password channel not configured safely'); process.exit(255); }
    const answer = spawnSync(process.env.SSH_ASKPASS, ["rentamac@fixture-host's password: "], { env: process.env, encoding: 'utf8' });
    if (answer.status !== 0 || answer.stdout !== expected + '\n') { process.stderr.write('Permission denied: ' + (answer.stdout ?? '')); process.exit(255); }
}
if (argv.includes('auth-failed')) { process.stderr.write('Permission denied (publickey).'); process.exit(255); }
if (argv.at(-1) !== 'sftp') {
    if (argv.includes('lost-host')) { fs.appendFileSync(path.join(root, 'effect'), 'once'); process.exit(255); }
    const child = spawn('bash', ['-c', argv.at(-1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 255));
} else {
    const uint = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const long = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
    const string = (s) => { const b = Buffer.from(s); return Buffer.concat([uint(b.length), b]); };
    const attrs = (s) => Buffer.concat([uint(1|4|8),long(s.size),uint(s.mode),uint(Math.floor(s.atimeMs/1000)),uint(Math.floor(s.mtimeMs/1000))]);
    const handles = new Map(); let serial = 0; let buffer = Buffer.alloc(0);
    const send = (p) => { const b = Buffer.concat([uint(p.length),p]); process.stdout.write(b.subarray(0,3)); process.stdout.write(b.subarray(3)); };
    process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE()+4) {
            const size = buffer.readUInt32BE(); const p = buffer.subarray(4,4+size); buffer = buffer.subarray(4+size);
            const type = p[0]; if (type === 1) {
                const hold = path.join(root, 'hold-sftp-init');
                if (fs.existsSync(hold)) {
                    fs.writeFileSync(path.join(root, 'sftp-init-ready'), 'ready');
                    while (fs.existsSync(hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
                send(Buffer.concat([Buffer.from([2]),uint(3)])); continue;
            }
            fs.appendFileSync(path.join(root, 'packets'), type + '\n');
            const hold = path.join(root, 'hold-sftp-' + type);
            if (fs.existsSync(hold)) {
                fs.writeFileSync(path.join(root, 'sftp-' + type + '-ready'), String(process.pid));
                while (fs.existsSync(hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            const id = p.subarray(1,5); let offset = 5;
            const number = () => { const n = p.readUInt32BE(offset); offset += 4; return n; };
            const text = () => { const n = number(); const b = p.subarray(offset,offset+n); offset += n; return b; };
            const status = (n, m='') => send(Buffer.concat([Buffer.from([101]),id,uint(n),string(m),string('')]));
            const reply = (t,...parts) => send(Buffer.concat([Buffer.from([t]),id,...parts]));
            try {
                if (type === 16) { let target = text().toString(); if (target === '.') target = root; reply(104,uint(1),string(fs.realpathSync(target)),string(''),uint(0)); }
                else if (type === 7 || type === 17) { const target = text().toString(); reply(105,attrs(type === 7 ? fs.lstatSync(target) : fs.statSync(target))); }
                else if (type === 3) {
                    const target = text().toString(); const flags = number(); const attrFlags = number(); const mode = attrFlags & 4 ? number() : 0o666;
                    let nodeFlags = flags & 2 ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
                    if (flags & 8) nodeFlags |= fs.constants.O_CREAT;
                    if (flags & 16) nodeFlags |= fs.constants.O_TRUNC;
                    if (flags & 32) nodeFlags |= fs.constants.O_EXCL;
                    if (flags & 4) nodeFlags |= fs.constants.O_APPEND;
                    const h = String(++serial); handles.set(h,{fd:fs.openSync(target,nodeFlags,mode),append:!!(flags & 4)}); reply(102,string(h));
                }
                else if (type === 8) { const h = handles.get(text().toString()); reply(105,attrs(fs.fstatSync(h.fd))); }
                else if (type === 4) { const name = text().toString(); const h = handles.get(name); if (h.fd !== undefined) fs.closeSync(h.fd); handles.delete(name); status(0); }
                else if (type === 5) { const h = handles.get(text().toString()); const position = Number(p.readBigUInt64BE(offset)); offset += 8; const length = number(); const b = Buffer.alloc(length); const n = fs.readSync(h.fd,b,0,length,position); if (!n) status(1); else reply(103,string(b.subarray(0,n))); }
                else if (type === 6) { const h = handles.get(text().toString()); const position = Number(p.readBigUInt64BE(offset)); offset += 8; const content = text(); fs.writeSync(h.fd,content,0,content.length,h.append ? null : position); if (argv.includes('lost-write')) process.exit(255); status(0); }
                else if (type === 9) { const target = text().toString(); number(); fs.truncateSync(target,Number(p.readBigUInt64BE(offset))); status(0); }
                else if (type === 11) { const target = text().toString(); const h = String(++serial); handles.set(h,{target, names:fs.readdirSync(target)}); reply(102,string(h)); }
                else if (type === 12) { const h = handles.get(text().toString()); const names = h.names.splice(0,2); if (!names.length) status(1); else reply(104,uint(names.length),...names.flatMap(name => [string(name),string(''),attrs(fs.lstatSync(path.join(h.target,name)))])); }
                else if (type === 13) { fs.unlinkSync(text().toString()); status(0); }
                else if (type === 14) { const target = text().toString(); const flags = number(); fs.mkdirSync(target,{mode:flags & 4 ? number() : 0o777}); status(0); }
                else if (type === 15) { fs.rmdirSync(text().toString()); status(0); }
                else if (type === 18) { fs.renameSync(text().toString(),text().toString()); status(0); }
                else status(8,'unsupported');
            } catch (e) { status(e.code === 'ENOENT' ? 2 : e.code === 'EACCES' ? 3 : 4,e.message); }
        }
    });
}
`;

export async function sshFixture(host = "fixture-host", password = false) {
    const root = await mkdtemp(join(tmpdir(), "coop-ssh-test-"));
    const bin = join(root, "bin");

    await mkdir(bin);
    await writeFile(join(bin, "ssh"), peer, { mode: 0o755 });
    const oldPath = process.env.PATH;
    const oldRoot = process.env.SSH_TEST_ROOT;
    const oldPassword = process.env.SSH_TEST_REQUIRE_PASSWORD;

    process.env.PATH = `${bin}:${oldPath}`;
    process.env.SSH_TEST_ROOT = root;

    if (password) {
        process.env.SSH_TEST_REQUIRE_PASSWORD = "1";
    } else {
        delete process.env.SSH_TEST_REQUIRE_PASSWORD;
    }

    return {
        root,
        env: new SshExecutionEnv({ host, cwd: root }),
        async close() {
            process.env.PATH = oldPath;

            if (oldPassword === undefined) {
                delete process.env.SSH_TEST_REQUIRE_PASSWORD;
            } else {
                process.env.SSH_TEST_REQUIRE_PASSWORD = oldPassword;
            }

            if (oldRoot === undefined) {
                delete process.env.SSH_TEST_ROOT;
            } else {
                process.env.SSH_TEST_ROOT = oldRoot;
            }

            await rm(root, { recursive: true, force: true });
        },
    };
}
