/** A thread's file namespace. Omitted locations are the Coop host, never the viewing device. */
import { HttpError } from "./errors.ts";
import { validateSshHost } from "./ssh-env.ts";

export type WorkspaceLocation = { kind: "ssh"; host: string };

/** SSH destinations are owner-configured aliases/accounts, not SSH options or shell fragments. */
export function parseWorkspaceLocation(value: unknown): WorkspaceLocation | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (
        typeof value !== "object" ||
        !("kind" in value) ||
        value.kind !== "ssh" ||
        !("host" in value) ||
        typeof value.host !== "string" ||
        value.host.length > 255
    ) {
        throw new HttpError(
            400,
            "Use an SSH alias, user@host or ssh://[user@]host:port, without passwords, options or spaces.",
        );
    }

    try {
        return { kind: "ssh", host: validateSshHost(value.host) };
    } catch {
        throw new HttpError(
            400,
            "Use an SSH alias, user@host or ssh://[user@]host:port, without passwords, options or spaces.",
        );
    }
}
