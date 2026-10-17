// Each installed client owns its reads; neither another person nor an old source can reuse them.
const emptyStatus = () => ({ data: null, loading: false, error: "" });

function scopeOf(session) {
    if (!session.me || session.id === null || session.conversation?.kind !== "session") {
        return null;
    }

    return JSON.stringify([session.me.id, session.me.role, session.id, session.canSteer]);
}

function refreshKey(session) {
    const source = session.sessions.find((each) => each.id === session.id);

    return JSON.stringify([
        scopeOf(session),
        session.busy,
        source?.workflow,
        source?.activeThreadId,
        source?.archived,
        session.profiles,
    ]);
}

/** Share one in-flight eligibility read across controls, hints and every picker opening. */
export function createHandoffState(pocket) {
    let session = pocket.session();
    let scope = { key: scopeOf(session) };
    let status = emptyStatus();
    let pending = null;
    let controller = null;
    let timer = null;
    let lastRefreshKey = null;
    let disposed = false;
    const subscribers = new Set();

    const publish = () => {
        const value = { session, status };

        for (const subscriber of subscribers) {
            subscriber(value);
        }
    };

    const matches = (expected) =>
        !disposed && scope === expected && scopeOf(pocket.session()) === expected.key;

    function refresh(id) {
        const current = pocket.session();

        if (disposed || scope.key === null || current.id !== id || !matches(scope)) {
            return Promise.resolve(null);
        }

        if (pending) {
            return pending;
        }

        const expected = scope;
        const stop = new AbortController();

        controller = stop;
        status = { ...status, loading: true, error: "" };
        publish();

        const request = Promise.resolve()
            .then(() =>
                matches(expected)
                    ? pocket.sessionApi(id, "handoffs", undefined, { signal: stop.signal })
                    : null,
            )
            .then(
                (data) => {
                    if (!matches(expected)) {
                        return null;
                    }

                    status = { data, loading: false, error: "" };
                    publish();

                    return data;
                },
                (failure) => {
                    if (matches(expected)) {
                        status = { ...status, loading: false, error: failure.message };
                        publish();
                    }

                    throw failure;
                },
            )
            .finally(() => {
                if (pending === request) {
                    pending = null;
                    controller = null;
                }
            });

        pending = request;

        return request;
    }

    function observe(value) {
        if (disposed) {
            return;
        }

        session = value;
        const key = scopeOf(session);

        if (key !== scope.key) {
            scope = { key };
            controller?.abort();
            controller = null;
            pending = null;
            status = emptyStatus();
        }

        const nextRefreshKey = refreshKey(session);

        if (nextRefreshKey !== lastRefreshKey) {
            lastRefreshKey = nextRefreshKey;
            clearInterval(timer);
            timer = null;

            if (key !== null) {
                refresh(session.id).catch(() => {});
                timer = setInterval(() => refresh(session.id).catch(() => {}), 10_000);
            }
        }

        publish();
    }

    const stop = pocket.onSessionChange(observe);

    observe(pocket.session());

    function useContext() {
        const [value, setValue] = pocket.useState(() => ({ session, status }));

        pocket.useEffect(() => {
            subscribers.add(setValue);
            setValue({ session, status });

            return () => subscribers.delete(setValue);
        }, []);

        return value;
    }

    function read(id) {
        if (scope.key === null || !matches(scope) || session.id !== id) {
            return Promise.resolve(null);
        }

        if (pending) {
            return pending;
        }

        if (status.data && !status.error) {
            return Promise.resolve(status.data);
        }

        return refresh(id);
    }

    function isCurrent(userId, id) {
        const current = pocket.session();

        return !disposed && current.me?.id === userId && current.id === id;
    }

    function dispose() {
        disposed = true;
        stop();
        clearInterval(timer);
        controller?.abort();
        subscribers.clear();
        pending = null;
        status = emptyStatus();
    }

    return { useContext, read, refresh, isCurrent, dispose };
}

export function profileName(profiles, id) {
    return profiles.find((profile) => profile.id === id)?.name ?? id;
}
