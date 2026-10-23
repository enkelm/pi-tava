/** Server-owned, passive Herdr lifecycle notifications, independent of browser and terminal connections. */
import { createHash } from "node:crypto";
import type { User } from "../config.ts";
import {
    foregroundAgent,
    foregroundPi,
    type LocalPiSessions,
    type LocalProcess,
    type ProcessInfo,
    type ProcessIdentity,
} from "../pi-sessions/herdr.ts";

export type HerdrAlertKind = "done" | "approval";
/** Alerts owns preferences, watching suppression and safe notification text, not this observer. */
export type HerdrAlertSink = (
    ownerId: string,
    paneId: string,
    kind: HerdrAlertKind,
    signal: AbortSignal,
) => Promise<void>;

const POLL_MS = 4000;
const MAX_AGENTS = 128;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
const identifier = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 256;

const processKey = (process: ProcessIdentity) =>
    hash([process.pid, process.parent, process.uid, process.started, process.commandHash]);

type Observation = {
    identity: string;
    process: string;
    state: "working" | "blocked" | "done" | "idle";
    sequence?: number;
};

type PaneSnapshot = Pick<Observation, "identity" | "state" | "sequence"> & { agent: string };

/** Parse both reads identically, retaining only identity hashes and lifecycle metadata. */
function snapshotPanes(value: unknown): Map<string, PaneSnapshot> | undefined {
    const data = record(value);
    const panes = data?.panes;

    if (
        !data ||
        !Array.isArray(panes) ||
        panes.length > 1000 ||
        (data.boot_id !== undefined && !identifier(data.boot_id))
    ) {
        return undefined;
    }

    const ids = new Set<string>();
    const result = new Map<string, PaneSnapshot>();

    for (const entry of panes) {
        const pane = record(entry);

        if (!pane || !identifier(pane.pane_id) || ids.has(pane.pane_id)) {
            return undefined;
        }

        ids.add(pane.pane_id);

        if (
            !identifier(pane.terminal_id) ||
            !identifier(pane.agent) ||
            ["unknown", "shell"].includes(pane.agent) ||
            typeof pane.agent_status !== "string" ||
            !["working", "blocked", "done", "idle"].includes(pane.agent_status) ||
            (pane.state_change_seq !== undefined &&
                (!Number.isSafeInteger(pane.state_change_seq) || Number(pane.state_change_seq) < 0))
        ) {
            continue;
        }

        let reference: unknown[] | undefined;

        if (pane.agent_session !== undefined && pane.agent_session !== null) {
            const ref = record(pane.agent_session);

            if (
                !ref ||
                [ref.agent, ref.source, ref.kind, ref.value].some(
                    (field) => typeof field !== "string" || field.length > 4096,
                )
            ) {
                continue;
            }

            reference = [ref.agent, ref.source, ref.kind, ref.value];
        }

        result.set(pane.pane_id, {
            identity: hash([data.boot_id, pane.terminal_id, pane.agent, reference]),
            agent: pane.agent,
            state: pane.agent_status as Observation["state"],
            ...(pane.state_change_seq === undefined
                ? {}
                : { sequence: Number(pane.state_change_seq) }),
        });
    }

    return result;
}

/** The exact opaque browser route identity shared with PrivateSessions' hierarchy. */
export function privatePaneId(socket: string, pane: string): string {
    return hash([socket, "pane", pane]);
}

/** One app-lifetime observer. A failed read or identity gap always discards its previous baseline.
 * It never reads journals, terminal output or history, sends input, or attaches a native client.
 */
export class HerdrAlerts {
    readonly #local: LocalPiSessions;
    readonly #owner: () => User | undefined;
    readonly #notify: HerdrAlertSink;
    readonly #abort = new AbortController();
    #task: Promise<void> | undefined;
    #previous = new Map<string, Observation>();
    #authority: string | undefined;

    constructor(local: LocalPiSessions, owner: () => User | undefined, notify: HerdrAlertSink) {
        this.#local = local;
        this.#owner = owner;
        this.#notify = notify;
    }

    start(): void {
        if (!this.#task && !this.#abort.signal.aborted) {
            this.#task = this.#run();
        }
    }

    async close(): Promise<void> {
        this.#abort.abort();
        await this.#task;
        this.#previous.clear();
    }

    #currentAuthority(): string | undefined {
        const owner = this.#owner();

        return owner?.role === "owner" ? hash([owner.id, owner.tokenHash]) : undefined;
    }

    async #run(): Promise<void> {
        const signal = this.#abort.signal;

        while (!signal.aborted) {
            try {
                await this.#observe(signal);
            } catch {
                // No replay across transport, process-table or malformed-snapshot gaps.
                this.#previous.clear();
            }

            if (signal.aborted) {
                break;
            }

            await new Promise<void>((resolve) => {
                const finish = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", finish);
                    resolve();
                };

                const timer = setTimeout(finish, POLL_MS);

                timer.unref();
                signal.addEventListener("abort", finish, { once: true });
            });
        }
    }

    async #observe(signal: AbortSignal): Promise<void> {
        const authority = this.#currentAuthority();

        if (!authority) {
            this.#authority = undefined;
            this.#previous.clear();

            return;
        }

        let eligible = true;

        const check = () => {
            signal.throwIfAborted();
            eligible &&= this.#currentAuthority() === authority;

            if (!eligible) {
                this.#previous.clear();
                this.#authority = undefined;

                throw new Error("Herdr notification eligibility changed");
            }
        };

        check();
        const sockets = [...new Set(await this.#local.sockets(signal))].slice(0, 33);

        check();
        const table = sockets.length ? await this.#local.processes(signal) : [];

        check();
        const current = new Map<string, Observation>();
        const deadline = Date.now() + 8000;
        let remaining = MAX_AGENTS;

        // All started reads are joined, even if another instance fails or close aborts them.
        await Promise.all(
            sockets.map(async (socket) => {
                try {
                    check();
                    const { snapshot } = await this.#local.request<{ snapshot: unknown }>(
                        socket,
                        "session.snapshot",
                        {},
                        2000,
                        signal,
                    );

                    check();
                    const panes = snapshotPanes(snapshot);

                    if (!panes) {
                        return;
                    }

                    const observations = new Map<string, Observation>();

                    // Bound process probes and their concurrency independently of snapshot size.
                    for (const [id, pane] of panes) {
                        check();

                        if (remaining <= 0 || Date.now() >= deadline) {
                            break;
                        }

                        remaining--;
                        const observation = await this.#pane(
                            socket,
                            id,
                            pane,
                            table,
                            signal,
                            check,
                        );

                        check();

                        if (observation) {
                            observations.set(id, observation);
                        }
                    }

                    if (!observations.size) {
                        return;
                    }

                    // Session/terminal replacement need not replace the OS process. Fence metadata
                    // across process-info reads too; this is a consistency check, not a native lease.
                    check();
                    const { snapshot: refreshed } = await this.#local.request<{
                        snapshot: unknown;
                    }>(socket, "session.snapshot", {}, 2000, signal);

                    check();
                    const fresh = snapshotPanes(refreshed);

                    if (!fresh) {
                        return;
                    }

                    for (const [id, observation] of observations) {
                        const before = panes.get(id)!;
                        const after = fresh.get(id);

                        if (
                            after?.identity === before.identity &&
                            after.state === before.state &&
                            after.sequence === before.sequence
                        ) {
                            current.set(privatePaneId(socket, id), observation);
                        }
                    }
                } catch {
                    // This instance must rebaseline after failure, even if its next reply is done.
                }
            }),
        );

        check();

        if (current.size) {
            // A snapshot/process-info round may straddle PID reuse. Recheck actual process lifetimes
            // after those reads, before treating a terminal state as the former agent's result.
            const live = new Set((await this.#local.processes(signal)).map(processKey));

            check();

            for (const [id, observation] of current) {
                if (!live.has(observation.process)) {
                    current.delete(id);
                }
            }
        }

        check();
        const previous =
            this.#authority === authority ? this.#previous : new Map<string, Observation>();

        this.#previous = current;
        this.#authority = authority;

        for (const [id, observation] of current) {
            const before = previous.get(id);

            if (!before || before.identity !== observation.identity) {
                continue;
            }

            if (
                before.sequence !== undefined &&
                observation.sequence !== undefined &&
                (observation.sequence < before.sequence ||
                    (observation.sequence === before.sequence &&
                        observation.state !== before.state))
            ) {
                current.delete(id);
                continue;
            }

            const kind =
                observation.state === "blocked" && before.state !== "blocked"
                    ? "approval"
                    : before.state === "working" &&
                        (observation.state === "done" || observation.state === "idle")
                      ? "done"
                      : undefined;
            const owner = this.#owner();

            check();

            if (kind && owner?.role === "owner") {
                // A failed/filtered delivery is consumed, never retried as a historical burst.
                await this.#notify(owner.id, id, kind, signal).catch(() => {});
                check();
            }
        }
    }

    async #pane(
        socket: string,
        id: string,
        pane: PaneSnapshot,
        table: LocalProcess[],
        signal: AbortSignal,
        check: () => void,
    ): Promise<Observation | undefined> {
        try {
            check();
            const { process_info } = await this.#local.request<{ process_info: ProcessInfo }>(
                socket,
                "pane.process_info",
                { pane_id: id },
                2000,
                signal,
            );

            check();
            const process =
                pane.agent === "pi"
                    ? foregroundPi(table, process_info)
                    : foregroundAgent(table, process_info);

            if (!process || !process.started || !process.commandHash) {
                return undefined;
            }

            const key = processKey(process);

            return {
                identity: hash([pane.identity, key]),
                process: key,
                state: pane.state,
                ...(pane.sequence === undefined ? {} : { sequence: pane.sequence }),
            };
        } catch {
            return undefined;
        }
    }
}
