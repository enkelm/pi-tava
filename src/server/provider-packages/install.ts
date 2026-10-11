import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface Installation {
    source: string;
    directory: string;
    npmCommand: string[];
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const STOP_GRACE_MS = 500;

/** Public SDK installs run in an owned POSIX process group, never in the server's process group. */
export async function installPackage(input: Installation, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        throw new Error("Provider installation was cancelled.");
    }

    if (process.platform === "win32") {
        throw new Error("Provider staging requires POSIX process-group cancellation.");
    }

    const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./install-worker.ts", import.meta.url))],
        {
            cwd: input.directory,
            detached: true,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
    );

    await new Promise<void>((resolve, reject) => {
        let installed = false;
        let settled = false;
        let cancellation: string | undefined;
        let stopTimer: NodeJS.Timeout | undefined;
        const deadline = setTimeout(
            () => cancel("Exact npm installation timed out; no selection was changed."),
            INSTALL_TIMEOUT_MS,
        );

        function killGroup(signal: NodeJS.Signals): void {
            if (!child.pid) {
                return;
            }

            try {
                process.kill(-child.pid, signal);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                    // Best effort direct-child fallback; never signal any unrelated process.
                    child.kill(signal);
                }
            }
        }

        function finish(error?: Error): void {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(deadline);

            if (stopTimer) {
                clearTimeout(stopTimer);
            }

            signal.removeEventListener("abort", aborted);
            killGroup("SIGKILL");

            if (error) {
                reject(error);
            } else {
                resolve();
            }
        }

        function cancel(reason: string): void {
            if (settled || cancellation) {
                return;
            }

            cancellation = reason;
            killGroup("SIGTERM");
            // Keep the grace timer even if the group leader exits first: npm descendants may remain.
            stopTimer = setTimeout(() => finish(new Error(reason)), STOP_GRACE_MS);
        }

        function aborted(): void {
            cancel("Provider installation was cancelled; no selection was changed.");
        }

        signal.addEventListener("abort", aborted, { once: true });
        child.on("message", (message) => {
            if (message && typeof message === "object" && "installed" in message) {
                installed = message.installed === true;
            }
        });
        child.once("error", () =>
            finish(new Error("Exact npm installer could not start; no selection was changed.")),
        );
        child.once("close", (code) => {
            if (!cancellation) {
                finish(
                    code === 0 && installed
                        ? undefined
                        : new Error("Exact npm installation failed; no selection was changed."),
                );
            }
        });
        child.send(input, (error) => {
            if (error) {
                cancel("Exact npm installer communication failed; no selection was changed.");
            }
        });

        if (signal.aborted) {
            aborted();
        }
    });
}
