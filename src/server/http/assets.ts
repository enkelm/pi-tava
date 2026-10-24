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
import { extname, join, posix, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { APP_ROOT } from "../config.ts";
import { HttpError } from "../errors.ts";
import {
    accepted,
    compressFile,
    compressible,
    type Encoding,
    MIN_COMPRESS_BYTES,
} from "./compress.ts";
import { escapeHtml, send } from "./io.ts";

export const WEB = join(APP_ROOT, "web");
const MODULES = join(APP_ROOT, "node_modules");

export const VENDOR: Record<string, string> = {
    "preact.mjs": join(MODULES, "preact", "dist", "preact.mjs"),
    "preact-hooks.mjs": join(MODULES, "preact", "hooks", "dist", "hooks.mjs"),
    "preact-compat.mjs": join(MODULES, "preact", "compat", "dist", "compat.mjs"),
    "preact-jsx-runtime.mjs": join(MODULES, "preact", "jsx-runtime", "dist", "jsxRuntime.mjs"),
    "blobatar-react.mjs": join(MODULES, "blobatar", "dist", "react.js"),
    "blobatar-expression.mjs": join(MODULES, "blobatar", "dist", "expression.js"),
    "blobatar-motion.css": join(MODULES, "blobatar", "dist", "motion.css"),
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

/** Last-read public app bytes, shared by static delivery and the preload graph. */
interface ReadFile {
    stamp: string;
    body: Buffer;
    hash: string;
    encoded: Map<Encoding, Promise<Buffer>>;
    imports?: string[];
}

const readFiles = new Map<string, ReadFile>();
const MAX_CACHED_FILE = 2 * 1024 * 1024;
const MAX_CACHED_BYTES = 16 * 1024 * 1024;
let cachedBytes = 0;

function forget(file: string): void {
    const previous = readFiles.get(file);

    if (previous !== undefined) {
        // Reserve room for identity plus both encodings, including compression overhead.
        cachedBytes -= previous.body.length * 4;
        readFiles.delete(file);
    }
}

/** Files edited in the last two seconds bypass reuse even on a coarse filesystem clock. */
function readNow(file: string): ReadFile {
    const stats = statSync(file, { bigint: true });
    const stamp = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
    const settled =
        Date.now() -
            Number((stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs) / 1_000_000n) >
        2000;
    const known = readFiles.get(file);

    if (known?.stamp === stamp && settled) {
        readFiles.delete(file);
        readFiles.set(file, known);

        return known;
    }

    forget(file);
    const body = readFileSync(file);
    const read: ReadFile = {
        stamp,
        body,
        hash: createHash("sha256").update(body).digest("hex").slice(0, 24),
        encoded: new Map(),
    };

    // Renderer payloads have a dedicated streaming route. Never retain them in this whole-file cache.
    if (
        settled &&
        body.length <= MAX_CACHED_FILE &&
        !file.startsWith(join(WEB, "herdr-renderer") + sep)
    ) {
        while (cachedBytes + body.length * 4 > MAX_CACHED_BYTES && readFiles.size > 0) {
            forget(readFiles.keys().next().value!);
        }

        readFiles.set(file, read);
        cachedBytes += body.length * 4;
    }

    return read;
}

/** Only public app modules and the declared vendored modules participate in the initial graph. */
function moduleFile(address: string): string | undefined {
    const vendor = /^\/vendor\/([^/]+)$/.exec(address)?.[1];

    if (vendor !== undefined) {
        return VENDOR[vendor];
    }

    return /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(address) &&
        !address.startsWith("/herdr-renderer/")
        ? join(WEB, address)
        : undefined;
}

// Static imports and re-exports only, not import(...). App sources use ordinary quoted specifiers.
const STATIC_IMPORT =
    /(?:^|\n)\s*(?:import|export)\b[^"'`;()]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function preloads(imports: Record<string, string>): string[] {
    const found = new Set<string>();

    const visit = (address: string) => {
        const file = moduleFile(address);

        if (file === undefined || found.has(address)) {
            return;
        }

        found.add(address);

        try {
            const read = readNow(file);

            read.imports ??= [...read.body.toString("utf8").matchAll(STATIC_IMPORT)].map(
                (match) => match[1] ?? match[2]!,
            );

            for (const specifier of read.imports) {
                const target = specifier.startsWith(".")
                    ? posix.join(posix.dirname(address), specifier)
                    : specifier.startsWith("/")
                      ? specifier
                      : imports[specifier];

                if (typeof target === "string") {
                    visit(target);
                }
            }
        } catch {
            // A missing module retains the browser's ordinary import error, not a broken app document.
        }
    };

    visit("/app.js");

    return [...found];
}

/** The app document keeps its revision and CSP while advertising only the initial static module graph. */
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

    const policy = appPolicy(body);

    try {
        const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(body)?.[1];
        const imports = map === undefined ? {} : JSON.parse(map).imports;
        const links = preloads(imports ?? {})
            .map((address) => `<link rel="modulepreload" href="${escapeHtml(address)}" />`)
            .join("\n        ");

        body = body.replace("</head>", () => `${links}\n    </head>`);
    } catch {
        // Invalid import-map edits fall back to the browser's ordinary module loading.
    }

    send(response, 200, body, "text/html; charset=utf-8", {
        "cache-control": "no-cache",
        "content-security-policy": policy,
    });
}

/** Live-editable static files revalidate by content and compress off the main thread. */
export async function serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
    fallbackType?: string,
): Promise<void> {
    let read: ReadFile;

    try {
        read = readNow(file);
    } catch {
        forget(file);
        send(response, 404, "Not found");

        return;
    }

    const type = fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const text = compressible(type);
    const encoding = text && read.body.length >= MIN_COMPRESS_BYTES ? accepted(request) : undefined;
    // Weak validation intentionally represents the decoded content across all encodings.
    const tag = `"${read.hash}"`;
    const headers: Record<string, string> = {
        "content-type": type,
        "cache-control": "no-cache",
        etag: `W/${tag}`,
        ...(text ? { vary: "accept-encoding" } : {}),
    };
    const tags = String(request.headers["if-none-match"] ?? "")
        .split(",")
        .map((candidate) => candidate.trim().replace(/^W\//, ""));

    if (
        (request.method === "GET" || request.method === "HEAD") &&
        (tags.includes(tag) || tags.includes("*"))
    ) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    let body = read.body;

    if (encoding !== undefined) {
        let encoded = read.encoded.get(encoding);

        if (encoded === undefined) {
            encoded = compressFile(read.body, encoding);
            read.encoded.set(encoding, encoded);
        }

        try {
            body = await encoded;
            headers["content-encoding"] = encoding;
        } catch {
            // Keep the identity answer usable; a later request may try compression again.
            read.encoded.delete(encoding);
        }
    }

    if (response.destroyed || response.writableEnded) {
        return;
    }

    response.writeHead(200, { ...headers, "content-length": String(body.length) });
    response.end(request.method === "HEAD" ? undefined : body);
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
