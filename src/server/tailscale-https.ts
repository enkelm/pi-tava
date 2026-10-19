/** Native HTTPS for this machine's Tailscale identity, without Serve, Funnel or persistent app keys. */
import { execFile } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer, type Server } from "node:https";
import { isIP } from "node:net";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createSecureContext } from "node:tls";

export interface TailscaleCertificate {
    hostname: string;
    address: string;
    key: Buffer;
    cert: Buffer;
}

const CLI_TIMEOUT = 30_000;
const MAX_OUTPUT = 1024 * 1024;
const REFRESH_INTERVAL = 12 * 60 * 60 * 1000;
const STATUS_PROBLEM = "Cannot read Tailscale status. Start Tailscale, sign in, and try again.";
const CERT_PROBLEM =
    "Cannot obtain a Tailscale HTTPS certificate. Enable HTTPS certificates in your tailnet and check native Tailscale CLI permissions.";
const INVALID_CERT =
    "Tailscale returned an invalid HTTPS certificate. Check this machine's clock and Tailscale HTTPS configuration.";

function aborted(): Error {
    return new DOMException("Tailscale HTTPS setup was cancelled.", "AbortError");
}

function checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw aborted();
    }
}

/** PATH is owner configuration; reject relative entries and unsafe ownership/permissions. */
async function trustedExecutable(path: string): Promise<string | undefined> {
    if (!isAbsolute(path) || process.getuid === undefined) {
        return undefined;
    }

    try {
        const canonical = await realpath(path);
        const uid = process.getuid();
        const info = await stat(canonical);

        if (!info.isFile() || (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022) !== 0) {
            return undefined;
        }

        // Resolve symlinks (Homebrew commonly uses them), then check the containing
        // tree. Root-owned sticky /tmp is safe as an ancestor, not a CLI directory.
        let directory = dirname(canonical);

        for (;;) {
            const parent = await stat(directory);
            const stickyAncestor =
                directory !== dirname(canonical) &&
                parent.uid === 0 &&
                (parent.mode & 0o1000) !== 0;
            // macOS /Applications is normally root:admin 0775. Those administrators
            // already control installed native apps; do not reject the supported fallback.
            const administratorGroup =
                (parent.uid === 0 || parent.uid === uid) &&
                (parent.mode & 0o002) === 0 &&
                (parent.gid === 0 || (process.platform === "darwin" && parent.gid === 80));

            if (
                !parent.isDirectory() ||
                (parent.uid !== 0 && parent.uid !== uid) ||
                ((parent.mode & 0o022) !== 0 && !stickyAncestor && !administratorGroup)
            ) {
                return undefined;
            }

            const next = dirname(directory);

            if (next === directory) {
                break;
            }

            directory = next;
        }

        await access(canonical, constants.X_OK);

        return canonical;
    } catch {
        return undefined;
    }
}

async function findCli(): Promise<string> {
    const paths = (process.env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, "tailscale"));

    if (process.platform === "darwin") {
        paths.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    }

    for (const path of paths) {
        const executable = await trustedExecutable(path);

        if (executable !== undefined) {
            return executable;
        }
    }

    throw new Error(
        "Native Tailscale CLI not found in a trusted PATH directory. Install Tailscale and add its CLI to PATH.",
    );
}

/** Wait for process close even on abort, and never expose child output through errors. */
async function runCli(
    executable: string,
    args: string[],
    problem: string,
    signal?: AbortSignal,
): Promise<Buffer> {
    checkSignal(signal);

    let finish!: (result: { failed: boolean; stdout: Buffer }) => void;
    const result = new Promise<{ failed: boolean; stdout: Buffer }>((resolve) => {
        finish = resolve;
    });
    const child = execFile(
        executable,
        args,
        {
            encoding: "buffer",
            timeout: CLI_TIMEOUT,
            maxBuffer: MAX_OUTPUT,
            killSignal: "SIGKILL",
            signal,
            windowsHide: true,
            env: { ...process.env, TAILSCALE_BE_CLI: "1" },
        },
        (error, stdout, stderr) => {
            stderr.fill(0);
            finish({ failed: error !== null, stdout });
        },
    );

    child.stdin?.end();

    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    const output = await result;

    if (output.failed || signal?.aborted) {
        output.stdout.fill(0);
        checkSignal(signal);

        throw new Error(problem);
    }

    return output.stdout;
}

function identity(output: Buffer): { hostname: string; address: string } {
    try {
        const status = JSON.parse(output.toString("utf8"));
        const self = status?.Self;
        const hostname: string =
            typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
        const labels = hostname.split(".");

        if (
            status?.BackendState !== "Running" ||
            hostname.length > 253 ||
            labels.length < 4 ||
            !hostname.endsWith(".ts.net") ||
            !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
            !Array.isArray(self?.TailscaleIPs)
        ) {
            throw new Error();
        }

        const address = self.TailscaleIPs.find((value: unknown) => {
            if (typeof value !== "string" || isIP(value) !== 4) {
                return false;
            }

            const [first, second] = value.split(".").map(Number);

            return first === 100 && second! >= 64 && second! <= 127;
        });

        if (typeof address !== "string") {
            throw new Error();
        }

        return { hostname, address };
    } catch {
        throw new Error(
            "Tailscale must be Running with this machine's full .ts.net DNS name and a tailnet IPv4 address. Check MagicDNS and the active Tailscale profile.",
        );
    }
}

/** Parse bytes, not a string containing the private key (strings cannot be wiped). */
function pemPair(output: Buffer): { cert: Buffer; key: Buffer } {
    let offset = 0;

    const skipSpace = () => {
        while ([9, 10, 13, 32].includes(output[offset]!)) {
            offset++;
        }
    };

    const block = (label: string): Buffer | undefined => {
        const begin = Buffer.from(`-----BEGIN ${label}-----`);
        const end = Buffer.from(`-----END ${label}-----`);

        skipSpace();

        if (!output.subarray(offset, offset + begin.length).equals(begin)) {
            return undefined;
        }

        const endOffset = output.indexOf(end, offset + begin.length);

        if (endOffset === -1) {
            throw new Error(INVALID_CERT);
        }

        const start = offset;

        offset = endOffset + end.length;

        return output.subarray(start, offset);
    };

    const certificates: Buffer[] = [];
    let certificate: Buffer | undefined;

    while ((certificate = block("CERTIFICATE")) !== undefined) {
        certificates.push(certificate, Buffer.from("\n"));
    }

    const key = block("PRIVATE KEY") ?? block("RSA PRIVATE KEY") ?? block("EC PRIVATE KEY");

    skipSpace();

    if (certificates.length === 0 || key === undefined || offset !== output.length) {
        throw new Error(INVALID_CERT);
    }

    return { cert: Buffer.concat(certificates), key: Buffer.from(key) };
}

function validateCertificate(certificate: TailscaleCertificate): void {
    try {
        const leaf = new X509Certificate(certificate.cert);
        const now = Date.now();
        const notBefore = Date.parse(leaf.validFrom);
        const notAfter = Date.parse(leaf.validTo);

        if (
            !Number.isFinite(notBefore) ||
            !Number.isFinite(notAfter) ||
            notBefore > now ||
            notAfter <= now ||
            leaf.checkHost(certificate.hostname, {
                subject: "never",
                wildcards: false,
                partialWildcards: false,
                multiLabelWildcards: false,
                singleLabelSubdomains: false,
            }) !== certificate.hostname ||
            !leaf.checkPrivateKey(createPrivateKey(certificate.key))
        ) {
            throw new Error();
        }

        createSecureContext({
            key: certificate.key,
            cert: certificate.cert,
            minVersion: "TLSv1.2",
        });
    } catch {
        throw new Error(INVALID_CERT);
    }
}

/** Callers own the returned key buffer and should wipe it after TLS has copied it. */
export async function loadTailscaleCertificate(
    options: {
        signal?: AbortSignal;
        host?: string;
        hostname?: string;
    } = {},
): Promise<TailscaleCertificate> {
    const { signal } = options;

    checkSignal(signal);

    const executable = await findCli();
    const status = await runCli(executable, ["status", "--json"], STATUS_PROBLEM, signal);
    let target: { hostname: string; address: string };

    try {
        target = identity(status);

        if (options.host !== undefined && options.host !== target.address) {
            throw new Error(
                "Tailscale HTTPS must bind to the active profile's tailnet IPv4 address. Remove --host or use that address.",
            );
        }

        if (options.hostname !== undefined && options.hostname !== target.hostname) {
            throw new Error(
                "Tailscale HTTPS identity changed. Select HTTPS access again for the active profile.",
            );
        }
    } finally {
        status.fill(0);
    }

    const output = await runCli(
        executable,
        ["cert", "--cert-file=-", "--key-file=-", "--min-validity=168h", target.hostname],
        CERT_PROBLEM,
        signal,
    );
    let key: Buffer | undefined;
    let complete = false;

    try {
        const pair = pemPair(output);
        const certificate = { ...target, ...pair };

        key = pair.key;

        checkSignal(signal);
        validateCertificate(certificate);
        complete = true;

        return certificate;
    } finally {
        output.fill(0);

        if (!complete) {
            key?.fill(0);
        }
    }
}

/** Creates TLS only; the caller owns listen/server.close. close() stops and joins certificate refresh. */
export async function createTailscaleHttpsServer(options: {
    handler: RequestListener;
    host?: string;
    signal?: AbortSignal;
    onProblem?: (message: string) => void;
}): Promise<{ server: Server; hostname: string; address: string; close(): Promise<void> }> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const cancel = () => {
        controller.abort();
        clearInterval(timer);
    };

    options.signal?.addEventListener("abort", cancel, { once: true });

    if (options.signal?.aborted) {
        cancel();
    }

    let certificate: TailscaleCertificate | undefined;

    try {
        certificate = await loadTailscaleCertificate({
            signal: controller.signal,
            ...(options.host === undefined ? {} : { host: options.host }),
        });
        checkSignal(controller.signal);

        const { hostname, address } = certificate;
        const server = createServer(
            { key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2" },
            options.handler,
        );
        let inFlight: Promise<void> | undefined;
        let closing: Promise<void> | undefined;

        const renew = async () => {
            let next: TailscaleCertificate | undefined;

            try {
                next = await loadTailscaleCertificate({
                    signal: controller.signal,
                    host: address,
                    hostname,
                });
                checkSignal(controller.signal);

                if (next.hostname !== hostname || next.address !== address) {
                    throw new Error();
                }

                server.setSecureContext({ key: next.key, cert: next.cert, minVersion: "TLSv1.2" });
            } catch {
                if (!controller.signal.aborted) {
                    try {
                        options.onProblem?.(
                            "Tailscale HTTPS certificate refresh failed. Keeping the previous certificate; check Tailscale, HTTPS permissions and the active profile. No HTTP fallback was started.",
                        );
                    } catch {
                        // A diagnostic callback must not turn refresh into an unhandled rejection.
                    }
                }
            } finally {
                next?.key.fill(0);
            }
        };

        timer = setInterval(() => {
            if (!controller.signal.aborted && inFlight === undefined) {
                inFlight = renew().finally(() => {
                    inFlight = undefined;
                });
            }
        }, REFRESH_INTERVAL);
        timer.unref();

        return {
            server,
            hostname,
            address,
            close() {
                closing ??= (async () => {
                    cancel();
                    options.signal?.removeEventListener("abort", cancel);
                    await inFlight;
                })();

                return closing;
            },
        };
    } catch (error) {
        cancel();
        options.signal?.removeEventListener("abort", cancel);

        throw error;
    } finally {
        certificate?.key.fill(0);
    }
}
