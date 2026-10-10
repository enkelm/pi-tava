// A synthetic Herdr and OS process table. Never connects to the user's Herdr or signals real Pi.
import type { App } from "./helpers.ts";
import { parseProcesses, type LocalProcess } from "../src/server/imports/herdr.ts";

export function fakeHerdr(app: App, path: string) {
    const uid = process.getuid?.() ?? 0;
    const pi = parseProcesses(`73002 73001 ${uid} S Mon Jan 1 00:00:00 2024 pi`)[0]!;
    const shell = parseProcesses(`73001 1 ${uid} S Mon Jan 1 00:00:00 2024 /bin/zsh`)[0]!;
    const state = {
        status: "idle",
        path,
        agent: "pi",
        referenceAgent: "pi",
        shellPid: shell.pid,
        foregroundGroup: pi.pid,
        table: [shell, pi] as LocalProcess[],
        signals: [] as number[],
        escapes: [] as unknown[],
        refuseAbort: false,
        onEscape: undefined as (() => void | Promise<void>) | undefined,
        refuseExit: false,
        omitArgv: false,
    };
    const local = app.imports.active.local;

    local.processes = async () => state.table;
    local.sockets = async () => ["/synthetic/herdr.sock"];

    local.request = async <T>(
        _socket: string,
        method: string,
        params?: Record<string, unknown>,
    ): Promise<T> => {
        if (method === "pane.send_keys") {
            state.escapes.push(params);
            await state.onEscape?.();

            if (!state.refuseAbort) {
                state.status = "idle";
                state.table = state.table.filter((item) => item.parent !== pi.pid);
            }

            return { type: "ok" } as T;
        }

        if (method === "session.snapshot") {
            return {
                snapshot: {
                    workspaces: [{ workspace_id: "workspace", label: "Example project" }],
                    panes: [
                        {
                            pane_id: "pane",
                            workspace_id: "workspace",
                            label: "Fix the search index",
                            cwd: "/example/project",
                            agent: state.agent,
                            agent_status: state.status,
                            agent_session: {
                                agent: state.referenceAgent,
                                source: "herdr:pi",
                                kind: "path",
                                value: state.path,
                            },
                        },
                    ],
                },
            } as T;
        }

        if (method !== "pane.process_info") {
            throw new Error(`Unexpected request: ${method}`);
        }

        return {
            process_info: {
                shell_pid: state.shellPid,
                foreground_process_group_id: state.table.some((item) => item.pid === pi.pid)
                    ? state.foregroundGroup
                    : shell.pid,
                foreground_processes: state.table
                    .filter((item) => item.pid === pi.pid)
                    .map((item) => ({
                        pid: item.pid,
                        ...(state.omitArgv ? {} : { argv: ["pi"] }),
                    })),
            },
        } as T;
    };

    local.signal = (pid) => {
        if (pid !== pi.pid) {
            throw new Error("Tried to signal something other than the selected fake Pi");
        }

        state.signals.push(pid);

        if (!state.refuseExit) {
            state.table = state.table.filter((item) => item.pid !== pid);
        }

        return true;
    };

    return { state, pi, shell, local };
}
