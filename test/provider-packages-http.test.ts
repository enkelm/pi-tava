// HTTP owns package privacy, consent and restart-only selection; discovery must not execute code.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

const directory = join(root, "provider-packages-http");
const marker = join(root, "provider-package-executed");
const packageRoot = join(root, "agent", "npm", "node_modules", "pi-provider-litellm");
const source = "npm:pi-provider-litellm@4.2.0";

mkdirSync(join(packageRoot, "src"), { recursive: true });
writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
        name: "pi-provider-litellm",
        version: "4.2.0",
        pi: { extensions: ["./src/index.ts"] },
    }),
);
writeFileSync(
    join(packageRoot, "src", "index.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default () => { throw new Error("Discovery executed an extension"); };`,
);
mkdirSync(join(directory, "extensions"), { recursive: true });
writeFileSync(
    join(directory, "extensions", "pi-providers.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "reserved drop-in executed");
export default () => { throw new Error("Reserved provider module was replaced"); };`,
);

after(cleanUp);

test("only the owner discovers packages; consent and restart separate selection from execution", async () => {
    let app = await openApp(scriptedModel(), directory);

    app.settings.setPackages([source]);

    const guest = app.config.addUser("Package guest", "guest");
    const viewer = app.config.addUser("Package viewer", "viewer");
    const server = createServer((request, response) =>
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} })(
            request,
            response,
        ),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    assert.ok(address !== null && typeof address === "object");

    const base = `http://127.0.0.1:${address.port}/api`;
    const request = (
        path: string,
        body?: unknown,
        token: string | null = app.config.ownerToken,
        csrf = true,
    ) =>
        fetch(base + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "content-type": "application/json",
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                ...(csrf ? { "x-pocket": "1" } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    const post = async (body: unknown, expected = 200) => {
        const response = await request("/provider-packages", body);

        assert.equal(response.status, expected, await response.clone().text());

        return response.json();
    };

    try {
        assert.equal((await request("/provider-packages", undefined, null)).status, 401);

        for (const token of [guest.token, viewer.token]) {
            assert.equal((await request("/provider-packages", undefined, token)).status, 403);
            assert.equal(
                (await request("/provider-packages", { action: "module", enabled: true }, token))
                    .status,
                403,
            );
        }

        assert.equal(
            (
                await request(
                    "/provider-packages",
                    { action: "module", enabled: true },
                    app.config.ownerToken,
                    false,
                )
            ).status,
            403,
        );

        const response = await request("/provider-packages");

        assert.equal(response.status, 200);
        assert.match(response.headers.get("cache-control") ?? "", /no-store/);

        const listed = await response.json();

        assert.equal(listed.enabled, false);
        assert.equal(listed.activeEnabled, false);
        assert.equal(listed.restartRequired, false);
        assert.match(JSON.stringify(listed), /pi-provider-litellm/);
        assert.equal(JSON.stringify(listed).includes(packageRoot), false);
        assert.equal(existsSync(marker), false, "metadata discovery never activates an extension");

        // A retained, disabled release lets configuration reach its real persistence boundary,
        // without npm traffic or running the package. The discovery sentinel remains unexecuted.
        const releaseId = randomUUID();
        const npm = join(directory, "provider-packages", "releases", releaseId, "npm");

        cpSync(packageRoot, join(npm, "node_modules", "pi-provider-litellm"), { recursive: true });
        writeFileSync(
            join(npm, "package-lock.json"),
            JSON.stringify({
                lockfileVersion: 3,
                packages: { "node_modules/pi-provider-litellm": { version: "4.2.0" } },
            }),
        );
        app.config.providerPackages = {
            packages: [
                {
                    name: "pi-provider-litellm",
                    enabled: false,
                    release: { id: releaseId, version: "4.2.0", source },
                    settings: {},
                },
            ],
        };
        const configured = await post({
            action: "configure",
            name: "pi-provider-litellm",
            settings: { baseUrl: "https://fixture.invalid" },
        });

        assert.equal(configured.packages[0].settings.baseUrl, "https://fixture.invalid");
        await post({ action: "install", source }, 400);
        await post({ action: "install", source: "npm:bad;touch-file@1.0.0", trusted: true }, 400);
        await post({ action: "module", enabled: "yes" }, 400);
        await post({ action: "unknown" }, 400);
        await post({ action: "enable", name: "pi-provider-litellm", enabled: true }, 400);

        const rejected = await post(
            {
                action: "configure",
                name: "pi-provider-litellm",
                settings: { apiKey: "temporary-key-must-not-be-echoed" },
            },
            400,
        );

        assert.equal(JSON.stringify(rejected).includes("temporary-key-must-not-be-echoed"), false);
        await post(
            {
                action: "configure",
                name: "pi-provider-litellm",
                settings: { aliases: { anthropic: "https://fixture.invalid" } },
            },
            400,
        );

        const pending = await post({ action: "module", enabled: true, trusted: true });

        assert.equal(pending.enabled, true);
        assert.equal(pending.activeEnabled, false);
        assert.equal(pending.restartRequired, true);
        assert.equal(existsSync(marker), false);
        assert.equal(app.models.getProvider("litellm"), undefined);

        const modules = (await app.extensions(owner(app))).modules;
        const compatibility = modules.find((module) => module.file === "pi-providers.ts");

        assert.ok(compatibility);
        assert.equal(compatibility.source, "built-in");
        assert.equal(compatibility.enabled, true);
        assert.equal(compatibility.restartOnly, true);
        assert.equal(compatibility.restartRequired, true);
        assert.equal((await request("/extensions/pi-providers.ts/reload", {})).status, 409);

        await app.close();
        app = await openApp(scriptedModel(), directory);

        const applied = await (await request("/provider-packages")).json();

        assert.equal(applied.enabled, true);
        assert.equal(applied.activeEnabled, true);
        assert.equal(applied.restartRequired, false);
        assert.equal(
            existsSync(marker),
            false,
            "a disabled package stays inactive even when its compatibility module starts",
        );

        const disabled = await post({ action: "module", enabled: false });

        assert.equal(disabled.enabled, false);
        assert.equal(disabled.activeEnabled, true);
        assert.equal(disabled.restartRequired, true);
        assert.equal(app.models.getProvider("litellm"), undefined);
    } finally {
        await app.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
