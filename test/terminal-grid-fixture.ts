// Static, generated terminal frames only. Never opens Herdr or Pocket data.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Structured terminal fixture</title>
<script type="importmap">{"imports":{"preact":"/preact.mjs","preact/hooks":"/hooks.mjs","htm":"/htm.mjs"}}</script>
<link rel="stylesheet" href="/terminal-grid.css">
<style>html,body{margin:0;background:#101419;color:#d8dee9;font:16px system-ui}*{box-sizing:border-box}
header{padding:12px}#fixture{height:calc(100dvh - 60px);min-height:300px}header input{font-size:16px;width:150px}</style>
</head><body><header>Terminal fixture <input id="outside" aria-label="Outside terminal"></header>
<div id="fixture"></div><script type="module" src="/terminal-grid-fixture.js"></script></body></html>`;

export async function terminalFixture(port = 0) {
    const paths: Record<string, [string, string]> = {
        "/terminal-grid.js": ["web/terminal-grid.js", "text/javascript"],
        "/terminal-keyboard.js": ["web/terminal-keyboard.js", "text/javascript"],
        "/terminal-grid.css": ["web/terminal-grid.css", "text/css"],
        "/terminal-grid-fixture.js": ["test/terminal-grid-fixture.js", "text/javascript"],
        "/preact.mjs": ["node_modules/preact/dist/preact.mjs", "text/javascript"],
        "/hooks.mjs": ["node_modules/preact/hooks/dist/hooks.mjs", "text/javascript"],
        "/htm.mjs": ["node_modules/htm/dist/htm.module.js", "text/javascript"],
    };
    const server = createServer((request, response) => {
        const path = new URL(request.url || "/", "http://fixture.invalid").pathname;
        const asset = paths[path];

        response.setHeader("Cache-Control", "no-store");

        if (path === "/") {
            response.setHeader("Content-Type", "text/html");
            response.end(html);
        } else if (asset) {
            response.setHeader("Content-Type", asset[1]);
            response.end(readFileSync(root + asset[0]));
        } else if (path === "/favicon.ico") {
            response.writeHead(204).end();
        } else {
            response.writeHead(404).end();
        }
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();

    if (!address || typeof address === "string") {
        throw new Error("Fixture address is unavailable");
    }

    return { server, url: `http://127.0.0.1:${address.port}/` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const fixture = await terminalFixture(Number(process.argv[2] || 0));

    console.log(`${fixture.url} (static terminal fixture, PID ${process.pid})`);
}
