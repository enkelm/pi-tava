// Auth owns non-delegable invite grants, persistence and redemption-time authority.
// These tests use only isolated configuration files: no app, listener or test-only production seam.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Auth } from "../src/server/auth.ts";
import { canContinuePiSessions, ConfigStore } from "../src/server/config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-invite-auth-"));

after(() => rmSync(root, { recursive: true, force: true }));

test("local Pi access is opt-in, persists on redemption and cannot be delegated by a guest", () => {
    const directory = join(root, "grants");
    const config = new ConfigStore(directory);
    const auth = new Auth(config);
    const own = config.users.find((user) => user.role === "owner")!;
    const existing = config.addUser("Existing", "guest").user;
    const granted = auth.createInvite(own, { role: "guest", continuePiSessions: true });
    const ordinary = auth.createInvite(own);
    const off = auth.createInvite(own, { role: "guest", continuePiSessions: false });
    const restarted = new ConfigStore(directory);
    const afterRestart = new Auth(restarted);

    assert.equal(canContinuePiSessions(own), true);
    assert.equal(canContinuePiSessions(restarted.userById(existing.id)!), false);
    assert.deepEqual(afterRestart.invite(granted.code), {
        role: "guest",
        continuePiSessions: true,
    });
    assert.deepEqual(afterRestart.invite(off.code), { role: "guest" });
    const joined = afterRestart.redeem(granted.code, "Allowed")!;

    assert.equal(joined.user.continuePiSessions, true);
    assert.equal(canContinuePiSessions(joined.user), true);
    assert.equal(afterRestart.redeem(granted.code, "Again"), undefined);
    assert.equal(
        afterRestart.redeem(ordinary.code, "Ordinary")!.user.continuePiSessions,
        undefined,
    );
    assert.equal(afterRestart.redeem(off.code, "Off")!.user.continuePiSessions, undefined);
    assert.throws(
        () => afterRestart.createInvite(joined.user, { role: "guest", continuePiSessions: true }),
        /owner/i,
    );
    const onward = afterRestart.createInvite(joined.user, { role: "guest" });

    assert.equal(afterRestart.redeem(onward.code, "Friend")!.user.continuePiSessions, undefined);
    assert.equal(new ConfigStore(directory).userById(joined.user.id)!.continuePiSessions, true);
});

test("Auth rejects grants to viewers or one session and rechecks the creator when redeeming", () => {
    const directory = join(root, "creator");
    const config = new ConfigStore(directory);
    const auth = new Auth(config);
    const own = config.users.find((user) => user.role === "owner")!;

    for (const grant of [
        { role: "viewer", continuePiSessions: true },
        { role: "guest", session: "1", continuePiSessions: true },
        { role: "owner", continuePiSessions: true },
    ] as const) {
        assert.throws(() => auth.createInvite(own, grant), /unrestricted|guest|steer/i);
    }

    const granted = auth.createInvite(own, { role: "guest", continuePiSessions: true });
    const ordinary = auth.createInvite(own, { role: "guest" });

    // Simulate retained invites whose creator was downgraded by a configuration migration.
    own.role = "guest";
    config.save();
    const restarted = new Auth(new ConfigStore(directory));

    assert.equal(restarted.redeem(granted.code, "No longer authorized"), undefined);
    assert.equal(restarted.invite(granted.code), undefined, "the invalid invite is spent");
    assert.ok(restarted.redeem(ordinary.code, "Ordinary invite still works"));

    for (const creator of [
        config.addUser("Viewer", "viewer").user,
        config.addUser("Scoped", "guest", ["1"]).user,
    ]) {
        assert.throws(() => auth.createInvite(creator), /invite|access/i);
    }

    // Redemption refuses malformed grants retained from older code, bypassing creation checks.
    own.role = "owner";

    for (const [index, role] of ["viewer", "guest"].entries()) {
        config.addInvite(`invalid-${index}`, {
            role: role === "viewer" ? "viewer" : "guest",
            ...(role === "guest" ? { session: "1" } : {}),
            continuePiSessions: true,
            createdBy: own.id,
            expiresAt: Date.now() + 60_000,
        });
        assert.equal(auth.redeem(`invalid-${index}`, "Invalid scope"), undefined);
    }
});
