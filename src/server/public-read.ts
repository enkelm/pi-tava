/** Bounded, credential-free HTTPS reads shared by research and the managed browser reader. */
import dns from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import {
    awaitWithContext,
    BACKGROUND_CONTEXT,
    withAbortSignal,
} from "@earendil-works/chord/context";

const blocked = new BlockList();

for (const [network, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
] as const) {
    blocked.addSubnet(network, bits, "ipv4");
}

/** IPv4 only, validated then pinned at transport; no second DNS resolution or proxy environment. */
export async function publicHttpsTarget(input: string, signal: AbortSignal) {
    if (input.length > 8192 || /[\x00-\x20\\]/.test(input)) {
        throw new Error("Give one bounded public HTTPS URL without whitespace or backslashes.");
    }

    const url = new URL(input);

    if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        (url.port !== "" && url.port !== "443") ||
        isIP(url.hostname) !== 0 ||
        !url.hostname.includes(".") ||
        url.hostname.endsWith(".")
    ) {
        throw new Error(
            "Research requires a public HTTPS hostname on port 443, without credentials or IP literals.",
        );
    }

    url.hash = "";
    signal.throwIfAborted();
    const addresses = await awaitWithContext(
        dns.lookup(url.hostname, { all: true, family: 4 }),
        withAbortSignal(signal, BACKGROUND_CONTEXT),
    );

    if (addresses.length === 0 || addresses.some(({ address }) => blocked.check(address, "ipv4"))) {
        throw new Error("Research refuses private, loopback, link-local or reserved destinations.");
    }

    return { url, address: addresses[0]!.address };
}

export interface PublicDocument {
    url: string;
    contentType: string;
    body: string;
}

/** GET only. Every redirect gets a new public-IP check; cookies/auth and remote resources never follow. */
export async function readPublicDocument(
    input: string,
    callerSignal?: AbortSignal,
): Promise<PublicDocument> {
    const budget = AbortSignal.timeout(20_000);
    const signal = callerSignal === undefined ? budget : AbortSignal.any([budget, callerSignal]);
    let next = input;

    for (let redirects = 0; redirects <= 4; redirects++) {
        const { url, address } = await publicHttpsTarget(next, signal);
        const response = await new Promise<{
            location?: string;
            contentType: string;
            body: string;
        }>((resolve, reject) => {
            const call = https.request(
                url,
                {
                    method: "GET",
                    signal,
                    agent: false,
                    rejectUnauthorized: true,
                    family: 4,
                    lookup: (_host, _options, done) => done(null, address, 4),
                    headers: {
                        "user-agent": "pi-tava",
                        accept: "text/html,text/plain,text/markdown,application/json;q=0.8",
                        "accept-encoding": "identity",
                    },
                },
                (incoming) => {
                    const status = incoming.statusCode ?? 0;
                    const contentType = String(incoming.headers["content-type"] ?? "")
                        .split(";")[0]!
                        .toLowerCase();

                    if (
                        [301, 302, 303, 307, 308].includes(status) &&
                        incoming.headers.location !== undefined
                    ) {
                        incoming.destroy();
                        resolve({ location: incoming.headers.location, contentType, body: "" });

                        return;
                    }

                    if (status < 200 || status >= 300) {
                        incoming.destroy();
                        reject(
                            new Error(`Research read returned HTTP ${status}; no automatic retry.`),
                        );

                        return;
                    }

                    if (
                        !/^(text\/(html|plain|markdown|x-markdown)|application\/(json|xhtml\+xml))$/.test(
                            contentType,
                        ) ||
                        ![undefined, "identity"].includes(incoming.headers["content-encoding"])
                    ) {
                        incoming.destroy();
                        reject(
                            new Error(
                                "Research accepts uncompressed HTML, plain text, Markdown or JSON documents only.",
                            ),
                        );

                        return;
                    }

                    const chunks: Buffer[] = [];
                    let bytes = 0;

                    incoming.on("data", (chunk: Buffer) => {
                        bytes += chunk.length;

                        if (bytes > 2 * 1024 * 1024) {
                            incoming.destroy(
                                new Error("Research document exceeds the 2 MiB limit."),
                            );

                            return;
                        }

                        chunks.push(chunk);
                    });
                    incoming.on("error", reject);
                    incoming.on("end", () =>
                        resolve({ contentType, body: Buffer.concat(chunks).toString("utf8") }),
                    );
                },
            );

            call.on("error", reject);
            call.end();
        });

        if (response.location === undefined) {
            return { url: url.href, contentType: response.contentType, body: response.body };
        }

        next = new URL(response.location, url).href;
    }

    throw new Error("Research redirect limit exceeded.");
}
