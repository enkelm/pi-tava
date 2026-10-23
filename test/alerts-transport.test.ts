// A cancelled owner-monitor delivery must reach the real Web Push fetch, not just stop its caller.
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";

after(cleanUp);

test("Herdr delivery cancellation propagates through the actual PushStore encryption and fetch", async (t) => {
    const app = await openApp(
        scriptedModel(() => fauxAssistantMessage("Unused.")),
        join(root, "alert-transport"),
    );

    t.after(() => app.close());
    app.privateSessions.local.sockets = async () => [];
    const store = app.pushStore!;
    const key = createECDH("prime256v1");

    key.generateKeys();
    store.subscribe(owner(app).id, {
        endpoint: "https://fcm.googleapis.com/cancel-test",
        keys: {
            p256dh: key.getPublicKey().toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
        },
    });
    const notify = store.notify.bind(store);
    const signal = new AbortController();
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
        admitted = resolve;
    });
    let cancelled = false;

    const fetcher: typeof fetch = async (_url, init) => {
        assert.equal(init?.method, "POST");
        assert.ok(
            init.body instanceof Uint8Array,
            "real encrypted Web Push body reaches transport",
        );
        const transportSignal = init.signal;

        assert.ok(transportSignal);
        admitted();

        return new Promise((_resolve, reject) => {
            const abort = () => {
                cancelled = true;
                reject(transportSignal.reason);
            };

            transportSignal.addEventListener("abort", abort, { once: true });

            if (transportSignal.aborted) {
                abort();
            }
        });
    };

    store.notify = (userId, message, options) =>
        notify(userId, message, { ...options, fetch: fetcher });
    const delivery = app.alerts.herdr(owner(app).id, "b".repeat(64), "done", signal.signal);

    await started;
    signal.abort();
    await delivery;
    assert.equal(cancelled, true);
    assert.equal(
        store.subscriptions(owner(app).id).length,
        1,
        "cancellation is not a gone subscription",
    );
});
