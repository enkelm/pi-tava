// Native owner/private-agent routes exercised without a socket listener or live data.
import "./helpers.ts";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createHandler } from "../src/server/http.ts";
import type { App } from "./helpers.ts";

export async function privateAgentRequest(
    app: App,
    path: string,
    body?: unknown,
    token = app.config.ownerToken,
) {
    const input = new IncomingMessage(new Socket());
    const output = new ServerResponse(input);
    let text = "";

    input.url = path.startsWith("/") ? path : `/api/${path}`;
    input.method = body === undefined ? "GET" : "POST";
    input.headers = {
        authorization: `Bearer ${token}`,
        "x-pocket": "1",
        "content-type": "application/json",
    };

    output.end = (chunk?: unknown) => {
        text = String(chunk ?? "");

        return output;
    };

    const handled = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    })(input, output);

    if (body !== undefined) {
        input.push(Buffer.from(JSON.stringify(await body)));
    }

    input.push(null);
    await handled;

    return new Response(text, {
        status: output.statusCode,
        headers: { "cache-control": String(output.getHeader("cache-control") ?? "") },
    });
}
