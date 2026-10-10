// The profile switch's HTTP permissions and its real persistent-browser behavior.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();

after(cleanUp);

test(
    "owner imports a profile; tabs share persistent storage without capturing other conversations",
    {
        skip:
            process.platform === "win32"
                ? "profile import is not supported on Windows"
                : executable === undefined
                  ? "no Chromium-based browser"
                  : false,
    },
    async () => {
        const source = mkdtempSync(join(root, "profile-source-"));
        const data = mkdtempSync(join(root, "profile-app-"));
        const receivedCookies: string[] = [];
        const site = createServer((request, response) => {
            receivedCookies.push(request.headers.cookie ?? "");
            response.end("<title>Profile fixture</title><h1>Local test</h1>");
        });

        await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
        const address = site.address();

        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/`;
        const originalArgs = process.env.PI_POCKET_BROWSER_ARGS;

        // Synthetic credentials only: neither the fixture nor its imported copy touches the OS keychain.
        process.env.PI_POCKET_BROWSER_ARGS = "--password-store=basic --use-mock-keychain";
        let app;
        let server;
        const seed = await Chromium.launch(executable!, source, []);

        try {
            const { targetId } = await seed.connection.send("Target.createTarget", { url });
            const { sessionId } = await seed.connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });

            await until(async () => {
                const value = await seed.connection.send(
                    "Runtime.evaluate",
                    {
                        expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
                        returnByValue: true,
                    },
                    sessionId,
                );

                return value.result.value === true;
            }, "source profile's local page");
            await seed.connection.send("Storage.setCookies", {
                cookies: [
                    {
                        name: "profile_fixture",
                        value: "copied",
                        url,
                        expires: Date.now() / 1000 + 3600,
                    },
                    {
                        name: "pocket_auth",
                        value: "synthetic-owner-cookie",
                        httpOnly: true,
                        url,
                        expires: Date.now() / 1000 + 3600,
                    },
                ],
            });
            await seed.connection.send(
                "Runtime.evaluate",
                {
                    expression: "localStorage.setItem('profile_fixture', 'source')",
                },
                sessionId,
            );
            const { cookies } = await seed.connection.send("Storage.getCookies");

            assert.ok(cookies.some((cookie: { name: string }) => cookie.name === "pocket_auth"));
            await seed.stop();
            receivedCookies.length = 0;

            app = await openApp(scriptedModel(), data);
            const guest = app.config.addUser("Guest", "guest");
            const viewer = app.config.addUser("Viewer", "viewer");
            const first = await newSession(app);
            const second = await newSession(app);

            server = createServer(
                createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
            );
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const bound = server.address();

            assert.ok(bound && typeof bound !== "string");
            const endpoint = `http://127.0.0.1:${bound.port}/api/browser-profiles`;
            const request = (token: string, action = "", body?: unknown, csrf = true) =>
                fetch(`${endpoint}${action}`, {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        authorization: `Bearer ${token}`,
                        ...(csrf ? { "x-pocket": "1" } : {}),
                        "content-type": "application/json",
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });

            for (const token of [guest.token, viewer.token]) {
                assert.equal((await request(token)).status, 403);
                assert.equal(
                    (await request(token, "/discover", { path: source, executable })).status,
                    403,
                );
                assert.equal(
                    (await request(token, "/default", { id: null, confirm: true })).status,
                    403,
                );
            }

            assert.equal(
                (
                    await request(
                        app.config.ownerToken,
                        "/default",
                        { id: null, confirm: true },
                        false,
                    )
                ).status,
                403,
            );
            const discovery = await request(app.config.ownerToken, "/discover", {
                path: source,
                executable,
            });

            assert.equal(discovery.status, 200, await discovery.clone().text());
            const { profiles } = await discovery.json();
            const choice = profiles.find(
                (profile: { profile: string }) => profile.profile === "Default",
            );

            assert.ok(choice);
            assert.equal(
                (await request(app.config.ownerToken, "/default", { id: choice.id })).status,
                400,
            );
            app.browsers.state(Number(second));
            let announced = false;
            const unsubscribe = app.browsers.subscribe((id, state) => {
                if (id === Number(second) && state.sharedProfile) {
                    announced = true;
                }
            });
            const old = await app.browsers.open(Number(first));
            const importing = await request(app.config.ownerToken, "/default", {
                id: choice.id,
                confirm: true,
            });

            assert.equal(importing.status, 200, await importing.clone().text());
            assert.equal(old.closed, true);
            assert.ok(app.browsers.state(Number(first)).sharedProfile);
            await until(() => announced, "profile switch announced to a conversation with no page");
            unsubscribe();
            const page = await app.browsers.open(Number(first));

            await page.navigate(url);
            assert.match(await page.evaluate("document.cookie"), /profile_fixture=copied/);
            assert.ok(
                receivedCookies.some((cookies) => cookies.includes("profile_fixture=copied")),
            );
            assert.doesNotMatch(
                receivedCookies.join("\n"),
                /pocket_auth=/,
                "app auth is stripped before the first shared page request",
            );
            assert.equal(await page.evaluate("localStorage.getItem('profile_fixture')"), "source");
            await page.evaluate("localStorage.setItem('profile_fixture', 'updated'); 1");
            const other = await app.browsers.open(Number(second));

            await other.navigate(url);
            assert.equal(
                await other.evaluate("localStorage.getItem('profile_fixture')"),
                "updated",
            );
            assert.equal(page.closed, false);
            assert.equal(page.url, url);
            await app.browsers.close(Number(first));
            assert.equal(other.closed, false);
            await app.close();
            app = await openApp(scriptedModel(), data);
            const reopened = await app.browsers.open(Number(first));

            await reopened.navigate(url);
            assert.match(await reopened.evaluate("document.cookie"), /profile_fixture=copied/);
            assert.equal(
                await reopened.evaluate("localStorage.getItem('profile_fixture')"),
                "updated",
            );
            await app.browsers.setDefaultProfile(null);
            assert.equal(app.browsers.state(Number(first)).sharedProfile, undefined);
            const clean = await app.browsers.open(Number(first));

            await clean.navigate(url);
            assert.equal(await clean.evaluate("document.cookie"), "");
            assert.equal(await clean.evaluate("localStorage.getItem('profile_fixture')"), "null");
        } finally {
            await seed.stop();
            server?.closeAllConnections();
            server?.close();
            await app?.close();
            site.closeAllConnections();
            site.close();

            if (originalArgs === undefined) {
                delete process.env.PI_POCKET_BROWSER_ARGS;
            } else {
                process.env.PI_POCKET_BROWSER_ARGS = originalArgs;
            }
        }
    },
);
