/** Submission-bound handoff correlation and the optional explicit slash-command route. */
import { createHash } from "node:crypto";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HttpError } from "./errors.ts";
import type { Relationship, ThreadType } from "./workflow-docs.ts";

const ROLES = new Set<ThreadType>([
    "chat",
    "researcher",
    "worker",
    "reviewer",
    "follow-up",
    "pull",
    "land",
    "publish",
]);
const USAGE = "Use /handoff <role> [--same|--new] [instructions...], or /handoff <direction>";

/** Opaque public correlation; neither raw submission identifiers nor the original request ID escape. */
export function handoffInputKey(userId: string, id: ConversationId, requestId: string): string {
    return createHash("sha256")
        .update(JSON.stringify(["agent-handoff", userId, Number(id), requestId]))
        .digest("hex");
}

/** Parse only the leading route. Everything after direction starts remains verbatim human prose. */
export function parseHandoffCommand(
    text: string,
): { targetType?: ThreadType; relationship?: Relationship; instructions?: string } | undefined {
    const command = /^\/handoff(?:\s|$)/i.exec(text.trimStart());

    if (command === null) {
        return undefined;
    }

    let rest = text.trimStart().slice("/handoff".length).trim();
    let relation: Relationship | undefined;
    let kind: ThreadType | undefined;
    const word = () => /^\S+/.exec(rest)?.[0] ?? "";

    const take = () => {
        const next = word();

        rest = rest.slice(next.length).trimStart();

        return next;
    };

    const flag = () => {
        const next = take();

        if (relation !== undefined || (next !== "--new" && next !== "--same")) {
            throw new HttpError(400, `${USAGE}. Choose one relationship flag before direction.`);
        }

        relation = next === "--new" ? "new-work" : "same-work";
    };

    if (rest.startsWith("--")) {
        flag();
    }

    const explicit = word();
    const role = explicit.toLowerCase();
    const normalized = role === "review" ? "reviewer" : role;
    const namespaced = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
        explicit,
    );

    // Keep namespaced routes pinned even when their extension is absent; treating them as prose
    // would let a later inference silently substitute another profile.
    if (ROLES.has(normalized) || namespaced) {
        kind = namespaced ? explicit : normalized;
        take();

        if (rest.startsWith("--")) {
            flag();
        }
    }

    if (rest.startsWith("--")) {
        throw new HttpError(400, `${USAGE}. Relationship flags must precede direction.`);
    }

    if (rest.length > 8000 || rest.includes("\0")) {
        throw new HttpError(400, "Handoff direction must be at most 8000 characters without NULs");
    }

    return {
        ...(kind === undefined ? {} : { targetType: kind }),
        ...(relation === undefined && kind === undefined
            ? {}
            : { relationship: relation ?? "same-work" }),
        ...(rest === "" ? {} : { instructions: rest }),
    };
}
