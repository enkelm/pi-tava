// Account-backed Cloudflare setup. Cloudflare's browser selects the zone; provisioning requires an exact preview.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { domainToASCII } from "node:url";
import { cloudflaredEnvironment, type NamedTunnel } from "./access.ts";

interface SetupUi {
    interactive: boolean;
    ask(question: string, initial: string): Promise<string | undefined>;
    confirm(question: string, fallback: boolean): Promise<boolean>;
    show(line: string): void;
    signal?: AbortSignal;
}

interface SetupState {
    version: 1;
    domain: string;
    hostname: string;
    tunnelName: string;
    stage: "planned" | "creating" | "created" | "ready";
    tunnelId?: string;
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HEX_ID = /^[a-f0-9]{32}$/i;

function domainName(value: string): string {
    if (/[/\\?#:@%\s]/.test(value.trim())) {
        throw new Error("Enter a DNS hostname without a scheme, path, port, or wildcard.");
    }

    const name = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ""));
    const labels = name.split(".");

    if (
        name.length > 253 ||
        labels.length < 2 ||
        labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
        throw new Error("Enter a DNS hostname without a scheme, path, port, or wildcard.");
    }

    return name;
}

export function suggestedCloudflareHostname(domain: string, device = hostname()): string {
    const label =
        device
            .split(".")[0]!
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 55)
            .replace(/-$/, "") || "device";

    return `pi-coop-${label}.${domainName(domain)}`;
}

/** Decode only cloudflared's ARGO TUNNEL TOKEN block. Never print its contents or forward its endpoint field. */
async function selectedDomain(certFile: string, signal?: AbortSignal): Promise<string> {
    const pem = readFileSync(certFile, "utf8");
    const block =
        pem.length <= 64_000
            ? /-----BEGIN ARGO TUNNEL TOKEN-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END ARGO TUNNEL TOKEN-----/.exec(
                  pem,
              )
            : undefined;
    let auth: { zoneID?: unknown; apiToken?: unknown };

    try {
        const parsed: unknown = JSON.parse(
            Buffer.from(block?.[1] ?? "", "base64").toString("utf8"),
        );

        if (parsed === null || typeof parsed !== "object") {
            throw new Error("Unsupported credential format");
        }

        auth = parsed;
    } catch {
        throw new Error(
            "Cloudflare returned an unsupported authorization certificate. No tunnel or DNS was created.",
        );
    }

    if (
        typeof auth.zoneID !== "string" ||
        !HEX_ID.test(auth.zoneID) ||
        typeof auth.apiToken !== "string" ||
        auth.apiToken.length === 0
    ) {
        throw new Error(
            "Cloudflare authorization is missing its zone credentials. No tunnel or DNS was created.",
        );
    }

    // This is a read-only preflight. A mistyped zone must never be silently appended to a DNS record by route dns.
    let response: Response;

    try {
        response = await fetch(`https://api.cloudflare.com/client/v4/zones/${auth.zoneID}`, {
            headers: { Authorization: `Bearer ${auth.apiToken}` },
            redirect: "error",
            signal:
                signal === undefined
                    ? AbortSignal.timeout(15_000)
                    : AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
    } catch {
        throw new Error(
            "Could not verify the selected Cloudflare domain. No tunnel or DNS was created.",
        );
    }

    if (!response.ok) {
        throw new Error(
            `Cloudflare domain verification failed, HTTP ${response.status}. No tunnel or DNS was created.`,
        );
    }

    let body: { success?: boolean; result?: { id?: string; name?: string } };

    try {
        body = (await response.json()) as typeof body;
    } catch {
        throw new Error(
            "Cloudflare returned an invalid domain response. No tunnel or DNS was created.",
        );
    }

    if (
        body === null ||
        body.success !== true ||
        body.result?.id !== auth.zoneID ||
        typeof body.result.name !== "string"
    ) {
        throw new Error(
            "Cloudflare did not verify the authorized domain. No tunnel or DNS was created.",
        );
    }

    return domainName(body.result.name);
}

function credentialsId(file: string): string | undefined {
    if (!existsSync(file)) {
        return undefined;
    }

    try {
        const credentials = JSON.parse(readFileSync(file, "utf8")) as { TunnelID?: unknown };

        if (typeof credentials.TunnelID === "string" && UUID.test(credentials.TunnelID)) {
            return credentials.TunnelID;
        }
    } catch {}

    throw new Error(
        "pi-tava's tunnel credential file is invalid. Existing Cloudflare resources were left untouched.",
    );
}

function readState(file: string): SetupState | undefined {
    if (!existsSync(file)) {
        return undefined;
    }

    try {
        const state = JSON.parse(readFileSync(file, "utf8")) as SetupState;

        if (
            state.version === 1 &&
            domainName(state.domain) === state.domain &&
            domainName(state.hostname) === state.hostname &&
            state.hostname.endsWith(`.${state.domain}`) &&
            /^pi-coop-[a-z0-9-]+$/.test(state.tunnelName) &&
            ["planned", "creating", "created", "ready"].includes(state.stage) &&
            (state.tunnelId === undefined || UUID.test(state.tunnelId))
        ) {
            return state;
        }
    } catch {}

    throw new Error(
        "pi-tava's custom-domain setup record is invalid. No account changes were attempted.",
    );
}

/** A kernel-owned lease avoids stale lock files after a crash. A port collision fails closed, never takes over. */
async function setupLease(directory: string): Promise<Server> {
    const digest = createHash("sha256").update(realpathSync(directory)).digest();
    const port = 49152 + (digest.readUInt16BE(0) % 16384);
    const server = createServer((socket) => socket.destroy());

    await new Promise<void>((resolveLease, reject) => {
        server.once("error", () =>
            reject(
                new Error(
                    "Another custom-domain setup is running, or its local setup-lock port is unavailable. No account changes were attempted.",
                ),
            ),
        );
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolveLease);
    });
    server.unref();

    return server;
}

/** Prepare once, then reuse a saved UUID without account queries or DNS changes on ordinary launches. */
export async function prepareCustomCloudflare(
    binary: string,
    dataDir: string,
    ui: SetupUi,
): Promise<NamedTunnel | undefined> {
    const directory = resolve(dataDir, "cloudflare-custom");
    const home = join(directory, "home");
    const certFile = join(home, ".cloudflared", "cert.pem");
    const credentialsFile = join(directory, "credentials.json");
    const stateFile = join(directory, "setup.json");
    const configFile = join(directory, "setup.yml");
    const logFile = join(directory, "setup.log");
    let lease: Server | undefined;
    let attemptDir: string | undefined;

    const waitForAnswer = async <T>(answer: Promise<T>): Promise<T> => {
        const signal = ui.signal;

        if (signal === undefined) {
            return answer;
        }

        signal.throwIfAborted();
        let abort: () => void;
        const aborted = new Promise<never>((_, reject) => {
            abort = () => reject(new Error("Cloudflare setup canceled"));
            signal.addEventListener("abort", abort, { once: true });
        });

        try {
            return await Promise.race([answer, aborted]);
        } finally {
            signal.removeEventListener("abort", abort!);
        }
    };

    const confirm = (question: string, fallback: boolean) =>
        waitForAnswer(ui.confirm(question, fallback));

    const save = (state: SetupState) => {
        const temp = `${stateFile}.new`;

        writeFileSync(temp, `${JSON.stringify(state, null, 4)}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, stateFile);
    };

    try {
        if (ui.signal?.aborted) {
            return undefined;
        }

        if (!existsSync(directory) && !ui.interactive) {
            ui.show(
                "Custom domain is not configured. Run pi-tava --access cloudflare-custom once in a terminal without -y.",
            );

            return undefined;
        }

        mkdirSync(directory, { recursive: true, mode: 0o700 });
        lease = await setupLease(directory);
        let state = readState(stateFile);
        let id = credentialsId(credentialsFile);

        if (state?.tunnelId !== undefined && id !== state.tunnelId) {
            throw new Error(
                "Saved tunnel credentials are missing or do not match. No account changes were attempted.",
            );
        }

        if (state?.stage === "ready") {
            if (id === undefined || id !== state.tunnelId) {
                throw new Error(
                    "Saved tunnel credentials are missing or do not match. No account changes were attempted.",
                );
            }

            return { hostname: state.hostname, tunnelId: id, credentialsFile };
        }

        if (!ui.interactive) {
            ui.show(
                "Custom domain is not configured. Run pi-tava --access cloudflare-custom once in a terminal without -y.",
            );

            return undefined;
        }

        if (state?.stage === "creating" && id === undefined) {
            ui.show(
                `The outcome of creating '${state.tunnelName}' is uncertain. Check it in Cloudflare before starting over.`,
            );

            if (
                await confirm(
                    "Forget this incomplete local attempt? This will NOT delete any Cloudflare resources.",
                    false,
                )
            ) {
                rmSync(stateFile);
            }

            return undefined;
        }

        if (state === undefined && id !== undefined) {
            throw new Error(
                "Unclaimed tunnel credentials exist in pi-tava's setup folder. No account changes were attempted.",
            );
        }

        mkdirSync(join(home, ".cloudflared"), { recursive: true, mode: 0o700 });
        attemptDir = mkdtempSync(join(directory, "auth-"));
        const commandHome = join(attemptDir, "home");
        const commandCertificate = join(attemptDir, "cert.pem");
        const loginCertificate = join(commandHome, ".cloudflared", "cert.pem");

        mkdirSync(join(commandHome, ".cloudflared"), { recursive: true, mode: 0o700 });
        writeFileSync(configFile, "{}\n", { mode: 0o600 });
        appendFileSync(logFile, `\n--- ${new Date().toISOString()} setup\n`, { mode: 0o600 });
        chmodSync(logFile, 0o600);

        const run = (args: string[], login = false): Promise<string> =>
            new Promise((resolveRun, reject) => {
                const child = spawn(
                    binary,
                    [
                        "tunnel",
                        "--config",
                        configFile,
                        "--origincert",
                        commandCertificate,
                        "--no-autoupdate",
                        "--loglevel",
                        "info",
                        ...args,
                    ],
                    {
                        stdio: ["ignore", "pipe", "pipe"],
                        env: {
                            ...cloudflaredEnvironment(),
                            HOME: commandHome,
                            USERPROFILE: commandHome,
                        },
                        signal: ui.signal,
                    },
                );
                let output = "";
                let failed = false;
                let forced: NodeJS.Timeout | undefined;

                const stop = () => {
                    failed = true;
                    child.kill();
                    forced ??= setTimeout(() => child.kill("SIGKILL"), 4000);
                };

                const timeout = setTimeout(stop, login ? 300_000 : 60_000);

                for (const stream of [child.stdout, child.stderr]) {
                    createInterface({ input: stream! }).on("line", (line) => {
                        appendFileSync(logFile, `${line}\n`);

                        if (login) {
                            ui.show(line);
                        }

                        output += `${line}\n`;

                        if (output.length > 1_000_000) {
                            stop();
                        }
                    });
                }

                child.on("error", stop);
                child.on("close", (code) => {
                    clearTimeout(timeout);
                    clearTimeout(forced);

                    if (!failed && code === 0 && output.length <= 1_000_000) {
                        resolveRun(output);
                    } else {
                        reject(
                            new Error(
                                `Cloudflare setup stopped. Existing DNS records were not overwritten. Private log: ${logFile}`,
                            ),
                        );
                    }
                });
            });

        if (!existsSync(certFile)) {
            ui.show(
                "Cloudflare will open in your browser. Select the domain to use for this device.",
            );

            if (
                !(await confirm(
                    "Sign in to Cloudflare for pi-tava? No tunnel or DNS is created by sign-in.",
                    false,
                ))
            ) {
                return undefined;
            }

            await run(["login"], true);

            if (!existsSync(loginCertificate)) {
                throw new Error(
                    "Cloudflare sign-in did not produce pi-tava's authorization certificate.",
                );
            }

            // Only the parent publishes authorization. An orphaned login after a crash can write only its unique HOME.
            copyFileSync(loginCertificate, `${certFile}.new`);
            chmodSync(`${certFile}.new`, 0o600);
            renameSync(`${certFile}.new`, certFile);
        }

        // Verify and provision with the same private, read-only snapshot, never a mutable shared login destination.
        chmodSync(certFile, 0o600);
        copyFileSync(certFile, commandCertificate);
        chmodSync(commandCertificate, 0o400);
        const domain = await selectedDomain(commandCertificate, ui.signal);

        ui.show(`Selected Cloudflare domain: ${domain}`);

        if (state !== undefined && state.domain !== domain) {
            throw new Error(
                "The saved attempt belongs to a different authorized domain. No account changes were attempted.",
            );
        }

        const answer = await waitForAnswer(
            ui.ask(
                "Public hostname (Ctrl+U clears):",
                state?.hostname ?? suggestedCloudflareHostname(domain),
            ),
        );

        if (answer === undefined) {
            return undefined;
        }

        const selected = domainName(answer);

        if (!selected.endsWith(`.${domain}`)) {
            throw new Error(`The hostname must be a subdomain of the selected domain, ${domain}.`);
        }

        if (selected.slice(0, -(domain.length + 1)).includes(".")) {
            ui.show(
                "This nested hostname may need an additional Cloudflare edge certificate. The default flat hostname avoids that requirement for a root-domain zone.",
            );
        }

        if (state === undefined) {
            state = {
                version: 1,
                domain,
                hostname: selected,
                tunnelName: `pi-coop-${randomBytes(8).toString("hex")}`,
                stage: "planned",
            };
        } else if (selected !== state.hostname) {
            ui.show(
                "Existing DNS aliases will be left alone. Only the newly confirmed hostname will be served.",
            );
            state.hostname = selected;
        }

        ui.show(`Public address: https://${state.hostname}`);
        ui.show(`Dedicated tunnel: ${state.tunnelName}`);
        ui.show(
            "Existing DNS records and tunnels will not be replaced. pi-tava sign-in is still required.",
        );

        if (
            !(await confirm(
                id === undefined
                    ? "Create this tunnel and DNS record?"
                    : "Finish this saved tunnel's DNS setup?",
                false,
            ))
        ) {
            return undefined;
        }

        if (id === undefined) {
            state.stage = "creating";
            save(state);
            await run(["create", "--credentials-file", credentialsFile, state.tunnelName]);
            id = credentialsId(credentialsFile);

            if (id === undefined) {
                throw new Error(
                    "Cloudflare did not return tunnel credentials. Check the saved attempt before retrying.",
                );
            }
        }

        state.tunnelId = id;
        state.stage = "created";
        save(state);
        const output = await run(["route", "dns", "--overwrite-dns=false", id, state.hostname]);
        const routed =
            /(?:Added CNAME )?([a-z0-9.-]+) (?:which will route to this tunnel|is already configured to route to your tunnel|updated to route to your tunnel)/i.exec(
                output,
            )?.[1];

        if (routed === undefined || domainName(routed) !== state.hostname) {
            throw new Error(
                `Cloudflare did not confirm the exact requested DNS name. Inspect the DNS record before retrying. Private log: ${logFile}`,
            );
        }

        state.stage = "ready";
        save(state);
        chmodSync(credentialsFile, 0o600);
        ui.show(
            `Saved https://${state.hostname}. Future launches reuse this tunnel; DNS and HTTPS may need time to become ready.`,
        );

        return { hostname: state.hostname, tunnelId: id, credentialsFile };
    } catch (error) {
        if (!ui.signal?.aborted) {
            ui.show(
                error instanceof Error ? error.message : "Cloudflare custom-domain setup failed.",
            );
        }

        return undefined;
    } finally {
        if (attemptDir !== undefined) {
            rmSync(attemptDir, { recursive: true, force: true });
        }

        if (lease !== undefined) {
            await new Promise<void>((resolveLease) => lease!.close(() => resolveLease()));
        }
    }
}
