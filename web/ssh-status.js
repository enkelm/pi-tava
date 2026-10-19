// Recent, per-browser SSH evidence, never a persistent connection or a background host probe.
import { store } from "./store.js";
import { html } from "./ui.js";

const RECENT_MS = 2 * 60 * 1000;
const MAX_HOSTS = 64;
const observations = new Map();

const userScope = () => {
    const user = store.state.me;

    return user ? JSON.stringify([user.id, user.role, user.sessions ?? null]) : null;
};

let scope = userScope();
let generation = 0;
let expiry = null;

store.subscribe(() => {
    const current = userScope();

    if (current !== scope) {
        scope = current;
        generation++;
        observations.clear();
        clearTimeout(expiry);
        expiry = null;
    }
});

const hostOf = (location) =>
    location?.kind === "ssh" && typeof location.host === "string" && location.host.trim()
        ? location.host
        : null;

function expire() {
    clearTimeout(expiry);
    expiry = null;
    const now = Date.now();
    let next = Infinity;

    for (const [host, observation] of observations) {
        if (observation.until <= now) {
            observations.delete(host);
        } else {
            next = Math.min(next, observation.until);
        }
    }

    if (next !== Infinity) {
        expiry = setTimeout(
            () => {
                expire();
                store.set({});
            },
            Math.max(0, next - now),
        );
    }
}

function publish(host, observation) {
    observations.delete(host);
    observations.set(host, observation);

    while (observations.size > MAX_HOSTS) {
        observations.delete(observations.keys().next().value);
    }

    expire();
    store.set({});
}

/**
 * Observe an actual SSH filesystem/directory request, returning its value or original error unchanged. Call only
 * around operations that really contact the selected target, not saved login metadata or host discovery. There is
 * no retry here. The latest-started request owns the evidence, so an older completion cannot replace newer results.
 */
export async function observeSsh(location, operation) {
    const host = hostOf(location);

    if (host === null || scope === null) {
        return operation();
    }

    const epoch = generation;
    const observation = { status: "checking", until: Infinity };

    publish(host, observation);
    const current = () => generation === epoch && observations.get(host) === observation;

    try {
        const result = await operation();

        if (current()) {
            publish(host, { status: "reachable", until: Date.now() + RECENT_MS });
        }

        return result;
    } catch (error) {
        if (current()) {
            // SSH filesystem failures currently cross the API as 409. A missing remote folder can be 404, but an
            // absent route can too; 401/403 can be Coop authorization, and network/5xx errors can be Coop itself.
            // Stay unknown for those ambiguous failures, rather than declaring the SSH host offline.
            const failed = error?.status === 409 && error?.name !== "AbortError";

            publish(host, {
                status: failed ? "unavailable" : "unknown",
                until: Date.now() + RECENT_MS,
            });
        }

        throw error;
    }
}

const labels = {
    unknown: "SSH status unknown; browse a remote folder to check",
    checking: "Checking remote workspace",
    reachable: "SSH reachable (last checked recently)",
    unavailable: "Remote workspace unavailable (last attempt failed)",
};

/** The same compact remote marker in project pickers and every Collab sidebar; local projects have no marker. */
export function RemoteProjectIcon({ location }) {
    const host = hostOf(location);

    if (host === null) {
        return null;
    }

    const observation = observations.get(host);
    const status = observation && observation.until > Date.now() ? observation.status : "unknown";
    const label = `${host}: ${labels[status]}`;

    return html`<span
        class="remote-project-icon"
        data-status=${status}
        role="img"
        aria-label=${label}
        title=${label}
    >
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M8 21h8m-4-4v4" />
        </svg>
        <span class="remote-project-status" aria-hidden="true"></span>
    </span>`;
}
