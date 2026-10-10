// A real stdio peer installed as the fixed pyright-langserver PATH binary by lsp.test.ts.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from "vscode-jsonrpc/node";

const log = (event) =>
    appendFileSync(
        join(process.cwd(), "lsp-trace.jsonl"),
        JSON.stringify({ pid: process.pid, ...event }) + "\n",
    );
const mode = (() => {
    try {
        return readFileSync(join(process.cwd(), "fixture-mode"), "utf8");
    } catch {
        return "normal";
    }
})();
const docs = new Map();
const connection = createMessageConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
);

log({ event: "start", args: process.argv.slice(2) });
process.on("SIGTERM", () => {
    log({ event: "stop" });
    process.exit(0);
});
connection.onClose(() => process.exit(0));
connection.onRequest("initialize", (params) => {
    log({ event: "initialize", params });

    if (mode === "crash-initialize") {
        process.exit(1);
    }

    if (mode === "hang-initialize") {
        return new Promise(() => {});
    }

    return {
        capabilities: {
            positionEncoding: "utf-16",
            textDocumentSync: 2,
            hoverProvider: true,
            completionProvider: {},
        },
        serverInfo: { name: "fixture", version: String(process.pid) },
    };
});
connection.onNotification("initialized", async () => {
    log({ event: "initialized" });
    const result = await connection.sendRequest("workspace/applyEdit", {
        edit: {
            changes: {
                [pathToFileURL(join(process.cwd(), "a.py")).href]: [
                    {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                        newText: "SERVER WRITE",
                    },
                ],
            },
        },
    });

    log({ event: "applyEditReply", result });
});
connection.onNotification("textDocument/didOpen", ({ textDocument }) => {
    docs.set(textDocument.uri, textDocument);
    log({ event: "didOpen", document: textDocument });
});
connection.onNotification("textDocument/didChange", async ({ textDocument, contentChanges }) => {
    const doc = { ...textDocument, text: contentChanges[0].text };

    docs.set(doc.uri, doc);
    log({ event: "didChange", document: doc });
    const diagnostics = [
        {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: doc.text,
            severity: 1,
        },
    ];

    await connection.sendNotification("textDocument/publishDiagnostics", {
        uri: doc.uri,
        version: doc.version,
        diagnostics,
    });
    await connection.sendNotification("textDocument/publishDiagnostics", {
        uri: pathToFileURL(join(process.cwd(), "foreign.py")).href,
        diagnostics,
    });

    if (mode === "flood") {
        for (let i = 0; i < 300; i++) {
            await connection.sendNotification("textDocument/publishDiagnostics", {
                uri: doc.uri,
                version: doc.version,
                diagnostics,
            });
        }

        log({ event: "flood-sent" });
    }
});
connection.onNotification("textDocument/didClose", ({ textDocument }) => {
    docs.delete(textDocument.uri);
    log({ event: "didClose", uri: textDocument.uri });
});
connection.onNotification((method, params) => log({ event: "notification", method, params }));
connection.onRequest("textDocument/hover", (params) => {
    log({ event: "hover", params });

    if (mode === "crash-hover") {
        process.exit(1);
    }

    if (mode === "hang-hover") {
        return new Promise(() => {});
    }

    return new Promise((resolve) =>
        setTimeout(
            () =>
                resolve({
                    contents: {
                        kind: "plaintext",
                        value: docs.get(params.textDocument.uri)?.text ?? "not open",
                    },
                    pid: process.pid,
                }),
            params.position.character === 0 ? 10 : 0,
        ),
    );
});
connection.listen();
