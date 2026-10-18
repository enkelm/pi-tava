/** The web app's own files and the modules it imports, its content security policy, and image files it shows. */
import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    createReadStream,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { APP_ROOT } from "../config.ts";
import { HttpError } from "../errors.ts";
import { send } from "./io.ts";

export const WEB = join(APP_ROOT, "web");
const MODULES = join(APP_ROOT, "node_modules");

export const VENDOR: Record<string, string> = {
    "preact.mjs": join(MODULES, "preact", "dist", "preact.mjs"),
    "preact-hooks.mjs": join(MODULES, "preact", "hooks", "dist", "hooks.mjs"),
    "htm.mjs": join(MODULES, "htm", "dist", "htm.module.js"),
    "marked.mjs": join(MODULES, "marked", "lib", "marked.esm.js"),
    "purify.mjs": join(MODULES, "dompurify", "dist", "purify.es.mjs"),
};

export const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
};

/** File types the image route shows; the bytes must match too (see `sniffImage`). */
const IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".bmp",
    ".ico",
    ".svg",
]);
const MAX_IMAGE_FILE = 25 * 1024 * 1024;
/** Opened on its own, an SVG could run script: give it an opaque origin and nothing to load. */
const IMAGE_CSP =
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** The image type of a file's first bytes, or undefined when it is not an image this app shows. */
export function sniffImage(head: Buffer): string | undefined {
    const ascii = (start: number, text: string) =>
        head.subarray(start, start + text.length).toString("latin1") === text;

    if (head[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) {
        return "image/png";
    }

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return "image/jpeg";
    }

    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
        return "image/gif";
    }

    if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
        return "image/webp";
    }

    if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) {
        return "image/avif";
    }

    if (ascii(0, "BM")) {
        return "image/bmp";
    }

    if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) {
        return "image/x-icon";
    }

    const text = head
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();

    if (text.startsWith("<") && /<svg[\s>]/i.test(text)) {
        return "image/svg+xml";
    }

    return undefined;
}

/**
 * The app page's policy. Replies show markdown that Pi wrote, and what Pi writes can be steered by any file or page it
 * reads: nothing on the page may load from, send to, or post to another site. The inline import map is allowed by hash.
 */
function appPolicy(html: string): string {
    // Browsers hash script text after turning CRLF and CR into LF, as their HTML parser does.
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        (match) =>
            `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
    );

    return [
        "default-src 'self'",
        ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ].join("; ");
}

/** The app page, with its content security policy. */
export function serveApp(response: ServerResponse, webRevision: string): void {
    let body: string;

    try {
        body = readFileSync(join(WEB, "index.html"), "utf8").replace(
            "<head>",
            `<head>\n        <meta name="pocket-web-revision" content="${webRevision}" />`,
        );
    } catch {
        send(response, 404, "Not found");

        return;
    }

    send(response, 200, body, "text/html; charset=utf-8", {
        "cache-control": "no-cache",
        "content-security-policy": appPolicy(body),
    });
}

export function serveFile(response: ServerResponse, file: string, fallbackType?: string): void {
    let body: Buffer;

    try {
        body = readFileSync(file);
    } catch {
        send(response, 404, "Not found");

        return;
    }

    // No caching: the app is edited live, and a reload should always get the newest files.
    send(
        response,
        200,
        body,
        fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        {
            "cache-control": "no-cache",
        },
    );
}

// Only the offline builder's public, content-addressed outputs are immutable. In particular,
// build.json, editable web sources and anything outside this allowlist keep ordinary freshness.
const RENDERER_ASSET =
    /^\/herdr-renderer\/([a-f0-9]{16})\/(index\.html|renderer\.js|style\.css|pkg\/herdr_renderer(?:\.js|_bg\.wasm)|LICENSE-APACHE|NOTICE-HERDR|NOTICE-PROTOCOL\.md|UPSTREAM\.md|upstream-files\.json|fonts\/(?:JetBrainsMonoNerdFont-OFL\.txt|JetBrainsMonoNerdFont-README\.md|NOTICE-JETBRAINS-NERD\.md))$/;

/** Encoding preferences apply only to the versioned painter's public code, never private output. */
function rendererEncoding(
    request: IncomingMessage,
    compressible: boolean,
): "gzip" | "identity" | null {
    const preferences = new Map<string, number>();

    for (const entry of (request.headers["accept-encoding"] ?? "").split(",")) {
        const [name, ...parameters] = entry.trim().toLowerCase().split(";");
        const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
        const value = quality === undefined ? 1 : Number(quality.trim().slice(2));

        preferences.set(
            name!.trim(),
            Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0,
        );
    }

    const gzip = preferences.get("gzip") ?? preferences.get("*") ?? 0;
    const identity = preferences.get("identity") ?? (preferences.get("*") === 0 ? 0 : 1);

    if (compressible && gzip > 0 && gzip >= identity) {
        return "gzip";
    }

    return identity > 0 ? "identity" : null;
}

/** Stream one immutable renderer build asset. False leaves ordinary static routing unchanged. */
export async function serveRendererAsset(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
): Promise<boolean> {
    const match = RENDERER_ASSET.exec(path);

    if (match === null) {
        return false;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "Method not allowed", undefined, { allow: "GET, HEAD" });

        return true;
    }

    const file = join(WEB, path.slice(1));
    let handle;

    try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        send(response, 404, "Not found");

        return true;
    }

    try {
        const stats = await handle.stat();

        if (!stats.isFile()) {
            send(response, 404, "Not found");

            return true;
        }

        const extension = extname(file);
        const compressible = extension === ".wasm" || extension === ".js" || extension === ".css";
        const encoding = rendererEncoding(request, compressible);

        if (encoding === null) {
            send(response, 406, "No acceptable encoding", undefined, { vary: "accept-encoding" });

            return true;
        }

        // Weak validation deliberately names the same content across identity and gzip delivery.
        const tag = `"${match[1]}-${match[2]}"`;
        const etag = `W/${tag}`;
        const headers: Record<string, string> = {
            "cache-control": "public, max-age=31536000, immutable",
            etag,
            "last-modified": stats.mtime.toUTCString(),
            "content-type": TYPES[extension] ?? "text/plain; charset=utf-8",
            vary: "accept-encoding",
        };
        const ifNoneMatch = request.headers["if-none-match"];
        const unchanged =
            ifNoneMatch === undefined
                ? Date.parse(request.headers["if-modified-since"] ?? "") >=
                  Math.floor(stats.mtimeMs / 1000) * 1000
                : ifNoneMatch
                      .split(",")
                      .some(
                          (candidate) =>
                              candidate.trim() === "*" ||
                              candidate.trim().replace(/^W\//, "") === tag,
                      );

        if (encoding === "gzip") {
            headers["content-encoding"] = "gzip";
        }

        if (unchanged) {
            response.writeHead(304, headers);
            response.end();

            return true;
        }

        if (encoding === "identity") {
            headers["content-length"] = String(stats.size);
        }

        response.writeHead(200, headers);

        if (request.method === "HEAD") {
            response.end();

            return true;
        }

        const source = handle.createReadStream({ autoClose: false });

        try {
            // Backpressure and client cancellation reach disk and zlib; no full-file JS buffer or
            // process-wide compressed cache is retained for the 12 MB painter payload.
            if (encoding === "gzip") {
                await pipeline(source, createGzip(), response);
            } else {
                await pipeline(source, response);
            }
        } catch {
            response.destroy();
        }

        return true;
    } finally {
        await handle.close();
    }
}

/** An image file from this machine, for `![alt](path)` in replies and for uploaded attachments. */
export function serveImage(request: IncomingMessage, response: ServerResponse, file: string): void {
    if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
        throw new HttpError(415, "Only image files can be shown");
    }

    let size: number;
    let mtime: number;
    let type: string | undefined;

    try {
        const stats = statSync(file);

        if (!stats.isFile()) {
            throw new Error("not a file");
        }

        size = stats.size;
        mtime = stats.mtimeMs;
        const head = Buffer.alloc(1024);
        const fd = openSync(file, "r");

        try {
            type = sniffImage(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new HttpError(404, "Image not found");
    }

    if (type === undefined) {
        throw new HttpError(415, "That file is not an image");
    }

    if (size > MAX_IMAGE_FILE) {
        throw new HttpError(413, "Image too large to show");
    }

    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`;
    const headers = {
        etag,
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CSP,
    };

    if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    response.writeHead(200, {
        ...headers,
        "content-type": type,
        "content-length": String(size),
    });
    createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
}
