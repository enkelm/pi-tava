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
        session.conversation?.threadType,
        session.conversation?.cwd,
        session.sessions
            .filter(
                (each) =>
                    each.id === session.id ||
                    (source?.workItemId && each.workItemId === source.workItemId),
            )
            .map((each) => [
                each.id,
                each.threadType,
                each.workItemId,
                each.activeThreadId,
                each.archived,
                each.busy,
                each.waiting,
                each.workflow,
            ])
            .sort(([left], [right]) => left - right),
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
    let pageHidden = false;
    let disposed = false;
    let activity = { paused: false };
    let revision = {};
    const subscribers = new Set();
    const invalidators = new Set();
    const pickers = new Set();
    const context = () => ({ session, status, scope, activity, revision });

    const publish = () => {
        const value = context();

        for (const subscriber of subscribers) {
            subscriber(value);
        }
    };

    const available = () =>
        !disposed &&
        !pageHidden &&
        document.visibilityState !== "hidden" &&
        navigator.onLine !== false;
    const matches = (expected) =>
        available() && scope === expected && scopeOf(pocket.session()) === expected.key;

    function refresh(id) {
        const current = pocket.session();

        if (disposed || scope.key === null || current.id !== id || !matches(scope)) {
            return Promise.resolve(null);
        }

        if (pending) {
            return pending;
        }

        const expected = scope;

        // A failed verification's cache must not become actionable merely because retry began.
        status = { data: status.error ? null : status.data, loading: true, error: "" };
        publish();

        const request = Promise.resolve()
            .then(async () => {
                while (matches(expected)) {
                    const reading = revision;
                    const stop = new AbortController();

                    controller = stop;

                    try {
                        const data = await pocket.sessionApi(id, "handoffs", undefined, {
                            signal: stop.signal,
                        });

                        if (!matches(expected)) {
                            return null;
                        }

                        if (reading !== revision) {
                            // Context changed during the read: never resolve hints or the picker
                            // with its old options. Coalesce changes into one serialized follow-up.
                            continue;
                        }

                        status = { data, loading: false, error: "" };
                        publish();

                        return data;
                    } catch (failure) {
                        if (!matches(expected)) {
                            return null;
                        }

                        if (reading !== revision) {
                            continue;
                        }

                        status = { ...status, loading: false, error: failure.message };
                        publish();

                        throw failure;
                    }
                }

                return null;
            })
            .finally(() => {
                if (pending === request) {
                    pending = null;
                    controller = null;
                }
            });

        pending = request;

        return request;
    }

    function syncTimer() {
        const demanded = [...pickers].some((picker) => picker.id === session.id);

        if (!available() || scope.key === null || !demanded) {
            clearInterval(timer);
            timer = null;
        } else if (timer === null) {
            timer = setInterval(() => refresh(session.id).catch(() => {}), 10_000);
        }
    }

    // Controls stay mounted, so only an actual picker opening admits periodic eligibility reads.
    function watchPicker(id) {
        const picker = { id };

        pickers.add(picker);
        syncTimer();

        return () => {
            pickers.delete(picker);
            syncTimer();
        };
    }

    function onInvalidate(listener) {
        invalidators.add(listener);

        return () => invalidators.delete(listener);
    }

    const invalidateHints = () => {
        for (const listener of invalidators) {
            listener();
        }
    };

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

        const paused = !available();
        const activityChanged = activity.paused !== paused;

        if (activityChanged) {
            // Identity records a suspension even if the UI batches hide and return together.
            activity = { paused };
        }

        if (paused) {
            clearInterval(timer);
            timer = null;
            lastRefreshKey = null;
            // Late responses stay fenced even if this source becomes visible before they settle.
            scope = { key };
            controller?.abort();
            controller = null;
            pending = null;
            status = { ...status, loading: false };

            if (activityChanged) {
                invalidateHints();
            }

            publish();

            return;
        }

        const nextRefreshKey = refreshKey(session);

        if (nextRefreshKey !== lastRefreshKey) {
            lastRefreshKey = nextRefreshKey;
            revision = {};
            status = { ...emptyStatus(), loading: key !== null };
            invalidateHints();

            if (key !== null) {
                refresh(session.id).catch(() => {});
            }
        }

        syncTimer();
        publish();
    }

    const resume = () => observe(pocket.session());

    const hide = () => {
        pageHidden = true;
        resume();
    };

    const show = () => {
        pageHidden = false;
        resume();
    };

    const stop = pocket.onSessionChange(observe);

    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    observe(pocket.session());

    function useContext() {
        const [value, setValue] = pocket.useState(context);

        pocket.useEffect(() => {
            subscribers.add(setValue);
            setValue(context());

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
        document.removeEventListener("visibilitychange", resume);
        window.removeEventListener("online", resume);
        window.removeEventListener("offline", resume);
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", show);
        clearInterval(timer);
        controller?.abort();
        subscribers.clear();
        invalidators.clear();
        pickers.clear();
        pending = null;
        status = emptyStatus();
    }

    return { useContext, read, refresh, watchPicker, onInvalidate, isCurrent, dispose };
}

export function profileName(profiles, id) {
    return profiles.find((profile) => profile.id === id)?.name ?? id;
}
