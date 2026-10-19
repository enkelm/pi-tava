import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { discoverSshHosts } from "../src/server/ssh-hosts.ts";

async function fixture(t: TestContext) {
    const home = await mkdtemp(join(tmpdir(), "coop-ssh-hosts-"));

    t.after(() => rm(home, { recursive: true, force: true }));

    async function write(path: string, content: string) {
        const target = join(home, path);

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);

        return target;
    }

    return { home, write };
}

// These tests own passive selector suggestions, not SSH resolution or connection
// behavior. All config roots are disposable; no real owner config is consulted.
test("discovers only concrete aliases from quoted/equals directives and nested static Includes", async (t) => {
    const f = await fixture(t);
    const sentinel = join(f.home, "executed");

    await f.write(
        ".ssh/config",
        `
  hOsT = Rentamac build "Quoted-Alias" 'Single-Alias' # ignored-comment-alias
  User private-user
  HostName private-host.example
  IdentityFile ~/.ssh/id_secret
  ProxyCommand touch ${sentinel}
  Match exec "touch ${sentinel}"
  Include = "conf.d/*.conf" "nested configs/start" "nested#config"
  Host after-match
  Host *.internal !excluded ? [ab]bad invalid:22 -oBad bad;command "space name"
  Hostile not-a-host
`,
    );
    await f.write(".ssh/conf.d/a.conf", "HOST zed rentamac\n");
    await f.write(".ssh/conf.d/b.conf", "Host devbox\n");
    // Nested relative Includes are rooted at ~/.ssh, not the including file's folder.
    await f.write(
        ".ssh/nested configs/start",
        'Include "conf.d/b.conf" "~/outside configs/remote"\n',
    );
    await f.write("outside configs/remote", "Host tilde-host\n");
    await f.write(".ssh/nested#config", "Host hash-path\n");
    await f.write(".ssh/known_hosts", "Host never-from-known-hosts\n");
    await f.write(".ssh/id_secret", "Host never-from-key\n");
    await f.write(".bash_history", "Host never-from-history\n");

    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: [
            "after-match",
            "build",
            "devbox",
            "hash-path",
            "Quoted-Alias",
            "Rentamac",
            "Single-Alias",
            "tilde-host",
            "zed",
        ],
        incomplete: false,
    });
    await assert.rejects(access(sentinel), { code: "ENOENT" });
});

test("known_hosts contributes only concrete saved names and preserves explicit ports as SSH URIs", async (t) => {
    const f = await fixture(t);

    await f.write(".ssh/config", "Host devbox\nInclude saved-host-records\n");
    await f.write(
        ".ssh/saved-host-records",
        "not-a-config-alias.example ssh-ed25519 KEY_FROM_INCLUDE\n",
    );
    await f.write(
        ".ssh/known_hosts",
        `
# comment.example ssh-ed25519 KEY_COMMENT
[gate1.rentamac.io]:20977 ssh-ed25519 KEY_RENTAMAC
plain.example,other.example,PLAIN.EXAMPLE ssh-rsa KEY_MULTIPLE
[2001:db8::1]:2200 ssh-ed25519 KEY_IPV6_PORT
2001:db8::2 ssh-ed25519 KEY_IPV6_DEFAULT
DEVBOX ssh-ed25519 KEY_DUPLICATE
[zero.example]:0 ssh-ed25519 KEY_ZERO
[too-large.example]:65536 ssh-ed25519 KEY_LARGE
[negative.example]:-1 ssh-ed25519 KEY_NEGATIVE
[nonnumeric.example]:port ssh-ed25519 KEY_NONNUMERIC
[suffix.example]:22junk ssh-ed25519 KEY_SUFFIX
|1|HASHED_SALT|HASHED_NAME ssh-ed25519 KEY_HASHED
*.wildcard.example,!negated.example,[ab],[ab].example ssh-ed25519 KEY_PATTERNS
  @revoked revoked.example ssh-ed25519 KEY_REVOKED
@cert-authority ca.example ssh-ed25519 KEY_CA
@unknown marker.example ssh-ed25519 KEY_MARKER
user@not-a-saved-host.example ssh-ed25519 KEY_USER
Include should-not-be-a-config-include
`,
    );
    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: [
            "[2001:db8::2]",
            "devbox",
            "other.example",
            "plain.example",
            "ssh://[2001:db8::1]:2200",
            "ssh://gate1.rentamac.io:20977",
        ],
        incomplete: false,
    });
});

test("missing optional configs/Includes are normal and Include cycles terminate", async (t) => {
    const f = await fixture(t);
    const options = { home: f.home };

    assert.deepEqual(await discoverSshHosts(options), { hosts: [], incomplete: false });
    await f.write(".ssh/config", "Host root\nInclude missing missing-dir/*.conf a\n");
    await f.write(".ssh/a", "Host Alpha\nInclude b alias-of-a\n");
    await f.write(".ssh/b", "Host beta ALPHA\nInclude config\n");
    await symlink("a", join(f.home, ".ssh/alias-of-a"));
    assert.deepEqual(await discoverSshHosts(options), {
        hosts: ["Alpha", "beta", "root"],
        incomplete: false,
    });
});

test("unreadable existing configs produce partial results, not a discovery failure", async (t) => {
    if (process.getuid?.() === 0) {
        t.skip("root can read files with mode 000");

        return;
    }

    const f = await fixture(t);
    const blocked = await f.write(".ssh/private.conf", "Host inaccessible\n");

    await f.write(".ssh/config", "Host available\nInclude private.conf\n");
    await chmod(blocked, 0);
    t.after(() => chmod(blocked, 0o600).catch(() => {}));
    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: ["available"],
        incomplete: true,
    });
});

test("nonregular files and unsupported expansions are skipped without running or expanding them", async (t) => {
    const f = await fixture(t);

    await f.write(
        ".ssh/config",
        'Host available\nInclude directory ${HOME}/ignored %d/ignored ~other/config `ignored`\nInclude "unterminated\n',
    );
    await mkdir(join(f.home, ".ssh/directory"));
    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: ["available"],
        incomplete: true,
    });
});

test("config and known_hosts share per-file and aggregate byte bounds", async (t) => {
    const f = await fixture(t);

    await f.write(".ssh/config", "Host available\nInclude large.conf\n");
    await f.write(".ssh/large.conf", "Host oversized\n" + "#".repeat(300 * 1024));
    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: ["available"],
        incomplete: true,
    });
    await f.write(".ssh/config", "Host available\n");
    await f.write(
        ".ssh/known_hosts",
        "oversized.example ssh-ed25519 KEY\n" + "#".repeat(300 * 1024),
    );
    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: ["available"],
        incomplete: true,
    });
    await f.write(".ssh/config", "Host available\nInclude chunks/*.conf\n");
    await f.write(
        ".ssh/known_hosts",
        "beyond-budget.example ssh-ed25519 KEY\n" + "#".repeat(230 * 1024),
    );

    for (let i = 0; i < 4; i++) {
        await f.write(`.ssh/chunks/${i}.conf`, `Host chunk-${i}\n` + "#".repeat(230 * 1024));
    }

    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: ["available", "chunk-0", "chunk-1", "chunk-2", "chunk-3"],
        incomplete: true,
    });
});

test("unmatched glob work is bounded even when empty directories produce no entries", async (t) => {
    const f = await fixture(t);

    await mkdir(join(f.home, ".ssh/empty"), { recursive: true });
    await f.write(".ssh/config", "Host available\n" + "Include empty/*.conf\n".repeat(8300));
    assert.deepEqual(await discoverSshHosts({ home: f.home }), {
        hosts: ["available"],
        incomplete: true,
    });
});

test("alias, file and Include-depth limits return useful bounded suggestions", async (t) => {
    const f = await fixture(t);

    await f.write(
        ".ssh/config",
        Array.from({ length: 600 }, (_, i) => `Host alias-${i}`).join("\n"),
    );
    await f.write(".ssh/known_hosts", "saved.example ssh-ed25519 KEY\n");
    const aliases = await discoverSshHosts({ home: f.home });

    assert.equal(aliases.incomplete, true);
    assert.equal(aliases.hosts.length, 256);
    assert.ok(aliases.hosts.includes("alias-0"));
    await f.write(".ssh/config", "Host available\nInclude many/*.conf\n");
    await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
            f.write(`.ssh/many/${String(i).padStart(3, "0")}.conf`, `Host file-${i}\n`),
        ),
    );
    const files = await discoverSshHosts({ home: f.home });

    assert.equal(files.incomplete, true);
    assert.ok(files.hosts.length > 1 && files.hosts.length <= 128);
    assert.ok(files.hosts.includes("available"));
    assert.ok(!files.hosts.includes("file-149"));
    await f.write(".ssh/config", "Host available\nInclude chain/0\n");

    for (let i = 0; i < 20; i++) {
        await f.write(`.ssh/chain/${i}`, `Host depth-${i}\nInclude chain/${i + 1}\n`);
    }

    const depth = await discoverSshHosts({ home: f.home });

    assert.equal(depth.incomplete, true);
    assert.ok(depth.hosts.includes("available"));
    assert.ok(depth.hosts.includes("depth-0"));
    assert.ok(!depth.hosts.includes("depth-19"));
});
