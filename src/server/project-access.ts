/** Owner-authored project selectors. Broad grants include future matching projects, never arbitrary destinations. */
import type { User } from "./config.ts";
import type { Project } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { parseWorkspaceLocation } from "./workspace-location.ts";

export interface ProjectAccess {
    all?: true;
    local?: true;
    hosts?: string[];
    projectIds?: string[];
}

export function parseProjectAccess(value: unknown): ProjectAccess {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, "projectAccess must be a project grant object");
    }

    const grant = value as Record<string, unknown>;

    if (Object.keys(grant).some((key) => !["all", "local", "hosts", "projectIds"].includes(key))) {
        throw new HttpError(400, "Unknown project access rule");
    }

    for (const key of ["all", "local"]) {
        if (grant[key] !== undefined && grant[key] !== true) {
            throw new HttpError(400, `${key} must be true or omitted`);
        }
    }

    const strings = (key: string, maximum: number): string[] => {
        const values = grant[key];

        if (values === undefined) {
            return [];
        }

        if (
            !Array.isArray(values) ||
            values.length > maximum ||
            !values.every(
                (item) =>
                    typeof item === "string" &&
                    item.length > 0 &&
                    item.length <= 256 &&
                    !item.includes("\0"),
            )
        ) {
            throw new HttpError(400, `${key} must be a bounded list of names`);
        }

        return [...new Set(values)].sort();
    };

    const hosts = strings("hosts", 64).map(
        (host) => parseWorkspaceLocation({ kind: "ssh", host })!.host,
    );
    const projectIds = strings("projectIds", 256);

    return {
        ...(grant.all === true ? { all: true } : {}),
        ...(grant.local === true ? { local: true } : {}),
        ...(hosts.length === 0 ? {} : { hosts }),
        ...(projectIds.length === 0 ? {} : { projectIds }),
    };
}

export function projectGranted(user: User, project: Pick<Project, "id" | "location">): boolean {
    if (user.role === "owner" || user.projectAccess === undefined) {
        return true;
    }

    const grant = user.projectAccess;

    return (
        grant.all === true ||
        grant.projectIds?.includes(project.id) === true ||
        (project.location === undefined
            ? grant.local === true
            : grant.hosts?.includes(project.location.host) === true)
    );
}
