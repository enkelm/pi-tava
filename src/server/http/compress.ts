/** Compression negotiated for text answers, cached static files, and flushable live event streams. */
import type { IncomingMessage } from "node:http";
import {
    type BrotliCompress,
    brotliCompress,
    constants,
    createBrotliCompress,
    createGzip,
    type Gzip,
    gzip,
} from "node:zlib";

export type Encoding = "br" | "gzip";

/** Smaller answers are sent as they are: compressing them saves next to nothing. */
export const MIN_COMPRESS_BYTES = 1024;

/** Images, fonts, archives and WASM are not generic text; the immutable renderer streams separately. */
export function compressible(type: string): boolean {
    return /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i.test(
        type,
    );
}

/** Prefer compression unless identity explicitly outweighs it; explicit exclusions override wildcards. */
export function accepted(request: IncomingMessage | undefined): Encoding | undefined {
    const header = request?.headers["accept-encoding"];

    if (typeof header !== "string") {
        return undefined;
    }

    const weights = new Map<string, number>();

    for (const part of header.toLowerCase().split(",")) {
        const [name = "", ...params] = part.split(";").map((each) => each.trim());
        const q = params.find((param) => param.startsWith("q="));
        const value = q === undefined ? 1 : Number(q.slice(2));

        weights.set(name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0);
    }

    const weight = (name: string) => weights.get(name) ?? weights.get("*") ?? 0;
    const br = weight("br");
    const gzip = weight("gzip");

    if ((weights.get("identity") ?? 0) > Math.max(br, gzip)) {
        return undefined;
    }

    if (br > 0 && br >= gzip) {
        return "br";
    }

    return gzip > 0 ? "gzip" : undefined;
}

/** Preserve other cache dimensions when adding encoding negotiation, including pre-set response headers. */
export function varyEncoding(vary: string): string {
    return vary
        .split(",")
        .some((part) => ["*", "accept-encoding"].includes(part.trim().toLowerCase()))
        ? vary
        : [vary, "accept-encoding"].filter(Boolean).join(", ");
}

// Quality 4 for one-off answers; 6 for files retained compressed. Quality 11 stalls cold file delivery.
const brotli = (quality: number, size?: number) => ({
    params: {
        [constants.BROTLI_PARAM_QUALITY]: quality,
        ...(size === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT]: size }),
    },
});

/** One-off API/HTML answers also run off-thread: a large JSON view must not block other tabs. */
export function compressed(body: Buffer | string, encoding: Encoding): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const done = (error: Error | null, result: Buffer) =>
            error === null ? resolve(result) : reject(error);

        if (encoding === "br") {
            brotliCompress(body, brotli(4, Buffer.byteLength(body)), done);
        } else {
            gzip(body, { level: 6 }, done);
        }
    });
}

/** Static bytes are compressed off the main thread, once per file version and accepted encoding. */
export function compressFile(body: Buffer, encoding: Encoding): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const done = (error: Error | null, result: Buffer) =>
            error === null ? resolve(result) : reject(error);

        if (encoding === "br") {
            brotliCompress(body, brotli(6, body.length), done);
        } else {
            gzip(body, { level: 9 }, done);
        }
    });
}

/** One compressor per stream, flushed after each event; Brotli retains a 1 MB rather than 4 MB window. */
export function streamCompressor(encoding: Encoding): {
    stream: Gzip | BrotliCompress;
    flush: number;
} {
    return encoding === "br"
        ? {
              stream: createBrotliCompress({
                  params: {
                      [constants.BROTLI_PARAM_QUALITY]: 4,
                      [constants.BROTLI_PARAM_LGWIN]: 20,
                  },
              }),
              flush: constants.BROTLI_OPERATION_FLUSH,
          }
        : { stream: createGzip({ level: 6 }), flush: constants.Z_SYNC_FLUSH };
}
