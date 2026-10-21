// First-party Work Item controls use the native owner-only API, not extension route authority.
async function request(id, body, signal) {
    const response = await fetch(`/api/c/${id}/orchestrator`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            "X-Pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`Could not read PiP status (HTTP ${response.status}).`);
    }

    if (!response.ok) {
        throw new Error(data.error ?? `PiP request failed (HTTP ${response.status}).`);
    }

    return data;
}

export function createSupervisorUi(pocket) {
    const { html, Icon } = pocket;
    const pending = new Map();
    let disposed = false;

    function current(userId, id) {
        const session = pocket.session();

        return (
            !disposed &&
            session.me?.id === userId &&
            session.me.role === "owner" &&
            session.id === id &&
            session.conversation?.kind === "session"
        );
    }

    function controllerOf(session) {
        return session.sessions.find((each) => each.supervisor?.conversationId === session.id);
    }

    async function open(session) {
        const key = `${session.me.id}.${session.id}`;

        if (pending.has(key) || !current(session.me.id, session.id)) {
            return;
        }

        let changed = false;
        const stop = pocket.onSessionChange((next) => {
            changed ||=
                next.id !== session.id ||
                next.me?.id !== session.me.id ||
                next.me?.role !== "owner";
        });
        const flight = request(session.id, { action: "open" });

        pending.set(key, flight);

        try {
            const result = await flight;

            if (!changed && current(session.me.id, session.id)) {
                pocket.navigate(result.orchestration.conversationId);
            }
        } catch (error) {
            if (!changed && current(session.me.id, session.id)) {
                pocket.notify("error", `${error.message} Click PiP again to check or retry.`);
            }
        } finally {
            stop();

            if (pending.get(key) === flight) {
                pending.delete(key);
            }
        }
    }

    function SupervisorButton({ session = pocket.session() }) {
        const source = session.sessions.find((each) => each.id === session.id);

        if (
            session.me?.role !== "owner" ||
            session.id === null ||
            session.conversation?.kind !== "session" ||
            controllerOf(session) ||
            (!source?.workItemId && source?.threadType !== "worker")
        ) {
            return null;
        }

        return html`<button
            class="handoff-icon-button handoff-button"
            aria-label="Open PiP chat"
            title="Open PiP chat"
            onClick=${() => open(session)}
        >
            <${Icon} name="pip" />
        </button>`;
    }

    return {
        SupervisorButton,
        dispose() {
            disposed = true;
        },
    };
}
