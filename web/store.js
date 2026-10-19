// App state, the server connection, and API calls. Components read `store.state` and re-render on `store.subscribe`.
import { onRoute, pushRoute } from "./back.js";
import { sessionForest } from "./session-tree.js";
import { workItemRows } from "./work-items.js";

/** A random id. crypto.randomUUID only exists on https and localhost pages; plain-http network addresses lack it. */
export function uid() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How many transcript rows a session shows when opened; "Show earlier messages" adds this many more. */
export const TRANSCRIPT_ROWS = 60;

const TAB_KEY = "pocket.tab";
const UNREAD_KEY = "pocket.unread";

/** Sessions this browser has marked unread, like the pinned list beside it (`pocket.unread`). */
function unreadOf() {
    try {
        const ids = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "[]");

        return Array.isArray(ids) ? ids : [];
    } catch {
        return [];
    }
}

const TAB = sessionStorage.getItem(TAB_KEY) ?? uid();

sessionStorage.setItem(TAB_KEY, TAB);

const emptyView = () => ({
    conversation: null,
    entries: new Map(),
    order: [],
    live: { busy: false },
    inbox: [],
    agent: null,
    stats: { cost: 0 },
    clients: 0,
    viewers: [],
    approvals: [],
    artifacts: [],
    subagents: [],
    authors: {},
    reactions: {},
    pins: [],
    turns: { on: false, asks: [] },
    decisions: {},
    plan: { on: false },
    schedules: [],
    goal: null,
    watch: null,
    branch: null,
    subagentsHeld: null,
    reviews: { threads: [], rev: 0 },
});

export const store = {
    state: {
        me: undefined, // undefined: unknown, null: signed out
        users: [],
        models: [],
        /** This tab's shared model refresh state and last result (`model-refresh.js`). */
        modelRefresh: { loading: false, result: null, error: null },
        guard: null,
        server: null,
        sessions: [],
        /** This person's favorite folders, in shortcut order, sent by the server to every signed-in device. */
        folderFavorites: [],
        projects: [],
        projectsLoaded: false,
        /** False until the server's first session list arrives: an empty list until then means "not here yet". */
        sessionsLoaded: false,
        /** Sessions on their way into the archive (true) or out of it (false), by id, until the list catches up (`sessions.js`). */
        moving: {},
        /** Sessions marked unread in this browser: an id each, until opened again. */
        unread: unreadOf(),
        conversationId: routeConversation(),
        privateId: routePrivate(),
        sidebarTab: location.pathname.startsWith("/private") ? "private" : "sessions",
        view: emptyView(),
        ...peopleFor(routeConversation()),
        history: null,
        /** The id of the oldest transcript entry shown, or null for the newest `TRANSCRIPT_ROWS` rows. */
        transcriptFrom: null,
        missing: null,
        connection: "connecting",
        notices: [],
        sheet: null,
        drawer: false,
        auth: null,
        /** A transcript message the next chat message discusses: `{ entryId, text }`. */
        chatQuote: null,
        /** Text to put into the message box to Pi: `{ text, n }`, picked up by the composer. */
        composerInsert: null,
        /** Pi's prompt templates for a conversation's folder: `{ conversationId, at, list }`. */
        templates: null,
        /** Whether Pi trusts a conversation's project, for its own skills (`trust.js`): `{ conversationId, cwd, info }`. */
        trust: null,
        /** The conversation whose subagents bar shows a row for each subagent (`subagents.js`); null for none. */
        subagentsOpen: null,
        /** The subagents board shows in the conversation's place (`subagents-board.js`). */
        board: false,
        /** Every subagent in every session, while the board shows; null until the server's first list arrives. */
        boardAgents: null,
        /** An extension's page in the conversation's place, as the board shows (`extension-ui.js`): `{ module, id }`. */
        page: null,
        /** Counts changes to what extensions' browser modules add (`extension-ui.js`), so what shows them draws again. */
        extensionsRev: 0,
        /** Counts the lists of files for @ mentions that arrived; the lists themselves are kept in `files.js`. */
        filesLoaded: 0,
        /** `!` commands this tab started that have no entry yet: `{ taskId, command, conversationId, at }`. */
        pendingShells: [],
        /** The session's browser page as the server last told: address, title, loading, size (`browser.js`). */
        browser: null,
        // Panel selection and Files tab belong to this conversation, kept locally in this browser tab.
        ...panelsFor(routeConversation(), { migrate: true }),
        /** The last request to show the People panel: which tab and chat message, and a count that tells requests apart. */
        peopleAsk: { tab: null, highlight: null, n: 0 },
        /** This person's PiP, as the server last told (`{ id, busy, endedAt }`); null when they have none yet. */
        pip: null,
        /** The PiP panel shows; kept per tab, like the browser's, so the reload after a live edit keeps it. */
        pipOpen: sessionStorage.getItem("pocket.pip") === "1",
        /** PiP's conversation, while the panel shows. */
        pipView: emptyView(),
    },
    listeners: new Set(),
    /**
     * Change the state: by a patch, or by what a function of the state returns. The function runs first, so a change
     * it makes on the way (a notice, say) is kept, not overwritten by the state as it was before.
     */
    set(patch) {
        const before = this.state;
        const change = typeof patch === "function" ? patch(before) : patch;

        this.state = { ...this.state, ...change };

        if (
            this.state.conversationId !== null &&
            ["browserOpen", "filesOpen", "peopleOpen", "filesTab"].some(
                (key) => before[key] !== this.state[key],
            )
        ) {
            savePanels(this.state.conversationId, this.state);
        }

        for (const listener of this.listeners) {
            listener(this.state);
        }
    },
    subscribe(listener) {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    },
};

// ─── Marked-unread sessions (this browser) ──────────────────────────────────────

export const isUnread = (id) => store.state.unread.includes(id);

/** Mark a session unread, or clear it again, in this browser only. Opening the session clears it (`opened`). */
export function setUnread(id, unread) {
    const next = unread
        ? [...new Set([...store.state.unread, id])]
        : store.state.unread.filter((each) => each !== id);

    localStorage.setItem(UNREAD_KEY, JSON.stringify(next));
    store.set({ unread: next });
}

/** Opening a session is reading it, however it opens (a tap, back, a link, a notification): its mark goes. */
function opened(id) {
    if (id !== null && isUnread(id)) {
        setUnread(id, false);
    }
}

opened(store.state.conversationId);

/** One selected panel per conversation. Pages and open files already have their own conversation owners. */
function savePanels(id, state) {
    sessionStorage.setItem(
        `pocket.panels.${id}`,
        JSON.stringify({
            panel: state.browserOpen
                ? "browser"
                : state.filesOpen
                  ? "files"
                  : state.peopleOpen
                    ? "people"
                    : null,
            filesTab: state.filesTab,
        }),
    );
}

function panelsFor(id, { migrate = false } = {}) {
    let saved = null;

    try {
        saved = id === null ? null : JSON.parse(sessionStorage.getItem(`pocket.panels.${id}`));
    } catch {
        // A malformed local preference must not prevent the app from opening.
    }

    if (migrate) {
        // Bind the old global preference only to the thread open at upgrade, never to an unseen thread.
        if (saved === null && id !== null) {
            saved = {
                panel:
                    sessionStorage.getItem("pocket.browser") === "1"
                        ? "browser"
                        : sessionStorage.getItem("pocket.files") === "1"
                          ? "files"
                          : sessionStorage.getItem("pocket.people") === "1"
                            ? "people"
                            : null,
                filesTab: sessionStorage.getItem("pocket.filesTab"),
            };
            sessionStorage.setItem(`pocket.panels.${id}`, JSON.stringify(saved));
        }

        for (const key of ["pocket.browser", "pocket.files", "pocket.people", "pocket.filesTab"]) {
            sessionStorage.removeItem(key);
        }
    }

    return {
        browserOpen: saved?.panel === "browser",
        filesOpen: saved?.panel === "files",
        peopleOpen: saved?.panel === "people",
        filesTab: saved?.filesTab === "changes" ? "changes" : "files",
        // Requests are transient, not a file selection to replay in another thread.
        filesTarget: null,
        filesAsk: null,
        reviewFocus: null,
        reviewTarget: null,
    };
}

function routeConversation() {
    const match = /^\/s\/(\d+)\/?$/.exec(location.pathname);

    return match ? Number(match[1]) : null;
}

/** Private pane ids are opaque and never enter a Durable room. */
function routePrivate() {
    const match = /^\/private\/([^/]+)\/?$/.exec(location.pathname);

    try {
        return match ? decodeURIComponent(match[1]) : null;
    } catch {
        return null;
    }
}

// ─── People: presence, typing, and the side chat ───────────────────────────────────

const CHAT_LIMIT = 500;

// A function declaration, not a const: the store's initial state calls it before this line runs.
function readKey(id) {
    return `pocket.chatRead.${id}`;
}

/** Fresh people state for a conversation: no one known yet, and how far this browser has read its chat. */
function peopleFor(id) {
    return {
        chat: [],
        presence: [],
        notes: null,
        chatQuote: null,
        chatRead: id === null ? 0 : chatReadOf(id),
    };
}

/** How far this browser has read a conversation's chat: the time of the newest message seen. */
function chatReadOf(id) {
    return Number(localStorage.getItem(readKey(id)) ?? 0);
}

/** Someone else chatted in a session after this browser last read its chat. */
export function sessionUnread(session, state = store.state) {
    const read = session.id === state.conversationId ? state.chatRead : chatReadOf(session.id);

    return session.chatAt !== undefined && session.chatBy !== state.me?.id && session.chatAt > read;
}

/**
 * Sessions in "workspace" order, as Alt+1…9 and the rail number them: pinned ones first (in the order they were
 * pinned), then the rest, newest first, each followed by the linked sessions under it, as the list shows them
 * (`session-tree.js`). Work Items target their active visible thread; pinning any visible member pins its row.
 * Archived sessions are left out.
 */
export function workspaceOrder(state = store.state) {
    const active = workItemRows(state.sessions, handoffsAvailable()).filter(
        (session) => !session.archived,
    );
    const pins = [
        ...new Set(
            state.pinned
                .map(
                    (id) =>
                        active.find(
                            (session) =>
                                session.id === id ||
                                session.members?.some((member) => member.id === id),
                        )?.id,
                )
                .filter((id) => id !== undefined),
        ),
    ];
    const { roots, rows } = sessionForest(active, { pinned: pins });
    const family = (root) => rows.get(root.id).map((row) => row.session);
    const pinned = pins.map((id) => roots.find((root) => root.id === id)).filter(Boolean);

    return [
        ...pinned.flatMap(family),
        ...roots.filter((root) => !pinned.includes(root)).flatMap(family),
    ];
}

/** Server features the web app may use. `collab` 2 adds roles, take turns, reactions, pins, notes, mentions, push. */
export const collab = () => (store.state.server?.collab ?? 0) >= 2;
/** Project organization is unavailable until the server has restarted with this capability. */
export const projectsAvailable = () => (store.state.server?.projects ?? 0) >= 1;
export const handoffsAvailable = () =>
    store.state.server?.ui?.some((module) => module.module === "work-items") === true;
/** Viewers read and chat; they never steer Pi. */
export const canSteer = () => store.state.me?.role !== "viewer";

/**
 * Whether this person may turn take turns on or off here, as the server decides: anyone who steers while it is off; the
 * driver, the owner, or anyone when nobody drives or the driver has left, while it is on.
 */
export function canToggleTurns() {
    const { me, presence, view } = store.state;
    const turns = view.turns;

    return (
        canSteer() &&
        (!turns?.on ||
            turns.driver === me?.id ||
            me?.role === "owner" ||
            !turns.driver ||
            !presence.some((person) => person.id === turns.driver))
    );
}

/** People invited to one session cannot start sessions or invite others. */
export const scoped = () => Array.isArray(store.state.me?.sessions);

/** The notices that announce chat messages, here or a mention elsewhere, by id: their session's. Reading its chat takes them down. */
const chatNotices = new Map();

/** Everything in the chat counts as read: called while the chat is open. */
export function markChatRead() {
    const { chat, chatRead, conversationId } = store.state;

    for (const [id, conversation] of chatNotices) {
        if (conversation === conversationId) {
            dismiss(id);
            chatNotices.delete(id);
        }
    }

    const last = chat.at(-1)?.at ?? 0;

    if (last <= chatRead || conversationId === null) {
        return;
    }

    localStorage.setItem(readKey(conversationId), String(last));
    store.set({ chatRead: last });
}

function applyChat(data) {
    const state = store.state;

    if (data.conversationId !== state.conversationId) {
        return;
    }

    const known = new Set(data.full ? [] : state.chat.map((message) => message.id));
    const added = data.messages.filter((message) => !known.has(message.id));

    store.set({ chat: (data.full ? data.messages : [...state.chat, ...added]).slice(-CHAT_LIMIT) });

    // The People panel stays open for long: on its Pinned or Notes tab, new messages still count and show a notice.
    if (chatLogs > 0) {
        markChatRead();

        return;
    }

    // A full list comes on connect: only live messages from others pop up.
    const fresh = data.full
        ? []
        : added.filter((message) => message.userId !== state.me?.id && message.kind !== "event");

    if (fresh.length === 0) {
        return;
    }

    const open = () => openSheet({ type: "chat" });
    const announce = (message) =>
        chatNotices.set(notify("info", message, open), store.state.conversationId);

    if (fresh.length > 1) {
        return announce(`${fresh.length} new chat messages`);
    }

    const [message] = fresh;
    const name = state.users.find((user) => user.id === message.userId)?.name ?? message.name;
    const text = message.text.replace(/\s+/g, " ");
    const mentioned = message.mentions?.includes(state.me?.id);

    announce(
        `${name}${mentioned ? " mentioned you" : ""}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
    );
}

let typingSent = { where: null, at: 0, conversationId: null };

/** Tell others this person is typing ("chat" or "pi") or stopped (null). Renewed at most every few seconds. */
export function typing(where) {
    const id = store.state.conversationId;

    if (!store.state.server?.chat || id === null) {
        return;
    }

    const now = Date.now();
    const same = typingSent.conversationId === id && typingSent.where === where;

    if (same && (where === null || now - typingSent.at < 3000)) {
        return;
    }

    typingSent = { where, at: now, conversationId: id };
    api(`c/${id}/typing`, { where }).catch(() => {});
}

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Call the server's API; signal aborts ordinary requests, keepalive lets small unload cleanups finish. */
export async function api(path, body, options = {}) {
    const init = {
        method: body === undefined && !options.method ? "GET" : (options.method ?? "POST"),
        headers: { "X-Pocket": "1" },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.keepalive ? { keepalive: true } : {}),
    };

    if (body !== undefined) {
        if (body instanceof Blob) {
            init.body = body;
            init.headers["content-type"] = body.type || "application/octet-stream";
        } else {
            init.body = JSON.stringify(body);
            init.headers["content-type"] = "application/json";
        }
    }

    const response = await fetch(`/api/${path}`, init);
    const text = await response.text();
    let data;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { error: text };
    }

    if (!response.ok) {
        throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
    }

    return data;
}

// Accepted keys and uncertain input identities are per-tab. Recovery only reads receipts, never replays input.
const HANDOFF_INPUTS_KEY = "pocket.handoffInputs";
const SUBMIT_ATTEMPTS_KEY = "pocket.submitAttempts";
let pendingHandoffInputs = readHandoffInputs();
let submitAttempts = readSubmitAttempts();
const submitLookups = new Map();
const submitFlights = new Map();
let handoffInputEpoch = 0;
let handoffInputScope = [store.state.conversationId, store.state.me?.id, store.state.privateId];
let handoffInputLookup = null;

function readHandoffInputs() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(HANDOFF_INPUTS_KEY));

        if (
            saved?.version === 1 &&
            Array.isArray(saved.requests) &&
            saved.requests.every(
                (request) =>
                    Number.isSafeInteger(request?.sourceId) &&
                    request.sourceId > 0 &&
                    typeof request.userId === "string" &&
                    typeof request.handoffRequestKey === "string" &&
                    request.handoffRequestKey.length > 0,
            )
        ) {
            return saved.requests;
        }
    } catch {
        // An invalid or unavailable per-tab store must not block normal input.
    }

    return [];
}

function saveHandoffInputs(requests) {
    pendingHandoffInputs = requests;

    try {
        if (requests.length === 0) {
            sessionStorage.removeItem(HANDOFF_INPUTS_KEY);
        } else {
            sessionStorage.setItem(HANDOFF_INPUTS_KEY, JSON.stringify({ version: 1, requests }));
        }
    } catch {
        if (requests.length > 0) {
            notify(
                "warning",
                "This browser cannot save automatic handoff navigation after reload.",
            );
        }
    }
}

function checkHandoffInputScope() {
    const { conversationId, me, privateId } = store.state;

    if (
        conversationId !== handoffInputScope[0] ||
        privateId !== handoffInputScope[2] ||
        (me !== undefined && me?.id !== handoffInputScope[1])
    ) {
        handoffInputEpoch++;
    }

    handoffInputScope = [conversationId, me?.id, privateId];

    const outsideScope = (request) =>
        request.sourceId !== conversationId ||
        privateId !== null ||
        (me !== undefined && request.userId !== me?.id);

    if (pendingHandoffInputs.some(outsideScope)) {
        saveHandoffInputs([]);
    }

    if (submitAttempts.some(outsideScope)) {
        saveSubmitAttempts([]);
    }
}

store.subscribe(checkHandoffInputScope);
checkHandoffInputScope();

function readSubmitAttempts() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(SUBMIT_ATTEMPTS_KEY));

        if (
            saved?.version === 1 &&
            Array.isArray(saved.requests) &&
            saved.requests.every(
                (request) =>
                    Number.isSafeInteger(request?.sourceId) &&
                    request.sourceId > 0 &&
                    typeof request.userId === "string" &&
                    typeof request.payload === "string" &&
                    typeof request.requestId === "string" &&
                    request.requestId.length > 0 &&
                    (request.receipt === undefined ||
                        typeof request.receipt.handoffRequestKey === "string"),
            )
        ) {
            return saved.requests;
        }
    } catch {
        // Invalid or unavailable storage must not prevent ordinary input.
    }

    return [];
}

function saveSubmitAttempts(requests) {
    submitAttempts = requests;

    try {
        if (requests.length === 0) {
            sessionStorage.removeItem(SUBMIT_ATTEMPTS_KEY);
        } else {
            sessionStorage.setItem(SUBMIT_ATTEMPTS_KEY, JSON.stringify({ version: 1, requests }));
        }
    } catch {
        if (requests.length > 0) {
            notify("warning", "This browser cannot save uncertain message recovery after reload.");
        }
    }
}

function forgetSubmitAttempt(attempt) {
    saveSubmitAttempts(submitAttempts.filter((request) => request !== attempt));
}

function submitScopeMatches(sourceId, userId, epoch) {
    return (
        epoch === handoffInputEpoch &&
        store.state.conversationId === sourceId &&
        store.state.privateId === null &&
        store.state.me?.id === userId
    );
}

function acceptSubmitReceipt(sourceId, userId, epoch, result) {
    if (
        submitScopeMatches(sourceId, userId, epoch) &&
        typeof result.handoffRequestKey === "string" &&
        userId !== undefined
    ) {
        rememberHandoffInput(sourceId, userId, result.handoffRequestKey);
        // Creation can publish retirement before either POST acceptance or receipt lookup returns.
        handoffSessionsChanged(store.state.sessions);
    }
}

/** Resolve uncertain acceptance without sending input. Keep the identity until the visible draft is sent again. */
function recoverSubmitAttempts() {
    checkHandoffInputScope();

    for (const attempt of submitAttempts) {
        const { sourceId, userId, requestId } = attempt;
        const epoch = handoffInputEpoch;

        if (!submitScopeMatches(sourceId, userId, epoch)) {
            continue;
        }

        if (attempt.receipt) {
            acceptSubmitReceipt(sourceId, userId, epoch, attempt.receipt);

            continue;
        }

        if (submitLookups.has(attempt)) {
            continue;
        }

        const lookup = api(`c/${sourceId}/submit?requestId=${encodeURIComponent(requestId)}`)
            .then((receipt) => {
                if (
                    submitScopeMatches(sourceId, userId, epoch) &&
                    submitAttempts.includes(attempt)
                ) {
                    attempt.receipt = receipt;
                    saveSubmitAttempts([...submitAttempts]);
                    acceptSubmitReceipt(sourceId, userId, epoch, receipt);
                }
            })
            .catch((error) => {
                // Absence is not rejection: the original POST might not have reached admission yet.
                if (error.status !== 404 && submitScopeMatches(sourceId, userId, epoch)) {
                    notify(
                        "error",
                        `Could not check message acceptance: ${error.message}`,
                        recoverSubmitAttempts,
                    );
                }
            })
            .finally(() => submitLookups.delete(attempt));

        submitLookups.set(attempt, lookup);
    }
}

function rememberHandoffInput(sourceId, userId, handoffRequestKey) {
    if (pendingHandoffInputs.some((request) => request.handoffRequestKey === handoffRequestKey)) {
        return;
    }

    saveHandoffInputs([...pendingHandoffInputs, { sourceId, userId, handoffRequestKey }]);
}

/** A completed tool result may redirect only the initiating tab, signed-in user and source route. */
function recoverHandoffInputs() {
    checkHandoffInputScope();
    const request = pendingHandoffInputs[0];

    if (!request || store.state.me?.id !== request.userId) {
        return;
    }

    if (handoffInputLookup !== null) {
        handoffInputLookup.again = true;

        return;
    }

    const flight = { again: false };
    const epoch = handoffInputEpoch;
    const keys = new Set(pendingHandoffInputs.map((input) => input.handoffRequestKey));

    handoffInputLookup = flight;
    api(`c/${request.sourceId}/transfers`)
        .then((data) => {
            if (
                epoch !== handoffInputEpoch ||
                store.state.conversationId !== request.sourceId ||
                store.state.me?.id !== request.userId
            ) {
                return;
            }

            const completed = data.transfers?.find(
                (record) =>
                    record.sourceThreadId === request.sourceId &&
                    keys.has(record.requestKey) &&
                    Number.isSafeInteger(record.targetThreadId),
            );

            if (completed) {
                saveHandoffInputs([]);
                navigate(completed.targetThreadId);
            }
        })
        .catch((error) => {
            if (epoch === handoffInputEpoch && store.state.conversationId === request.sourceId) {
                notify(
                    "error",
                    `Could not check handoff navigation: ${error.message}`,
                    recoverHandoffInputs,
                );
            }
        })
        .finally(() => {
            handoffInputLookup = null;

            if (flight.again) {
                recoverHandoffInputs();
            }
        });
}

function handoffSessionsChanged(sessions) {
    const accepted = pendingHandoffInputs[0];
    const acceptedSource = accepted && sessions.find((session) => session.id === accepted.sourceId);

    if (acceptedSource?.workflow?.readOnly) {
        recoverHandoffInputs();
    }
}

let nextNotice = 1;
/** Each notice's countdown, by id: what is left of it, and its timer while it runs. */
const countdowns = new Map();

/**
 * Show a short notice, and return its id. With `action`, tapping it runs the action as well as dismissing it. It stays longer when it
 * offers something (an Undo) or says what went wrong, and its countdown holds while a pointer or the focus is on it.
 */
export function notify(level, message, action) {
    const id = nextNotice++;
    const life = level === "error" ? 9000 : action ? 7000 : 4500;

    store.set((state) => ({
        notices: [...state.notices, { id, level, message, action, life }].slice(-4),
    }));
    countdowns.set(id, {
        left: life,
        since: Date.now(),
        timer: setTimeout(() => dismiss(id), life),
    });

    return id;
}

/** Hold a notice's countdown (`held`), or let it go on with what was left. */
export function holdNotice(id, held) {
    const countdown = countdowns.get(id);

    if (!countdown || held === (countdown.timer === null)) {
        return;
    }

    if (held) {
        clearTimeout(countdown.timer);
        countdown.timer = null;
        countdown.left -= Date.now() - countdown.since;
    } else {
        countdown.since = Date.now();
        countdown.timer = setTimeout(() => dismiss(id), Math.max(countdown.left, 1000));
    }
}

export function dismiss(id) {
    clearTimeout(countdowns.get(id)?.timer);
    countdowns.delete(id);
    chatNotices.delete(id);
    store.set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
}

/** Run an action and show its error, if any, as a notice. */
export async function attempt(action) {
    try {
        return await action();
    } catch (error) {
        notify("error", error.message ?? String(error));

        return undefined;
    }
}

/** End this browser's sign-in, and go to the sign-in page. */
export function signOut() {
    return attempt(async () => {
        await api("logout", {});
        location.href = "/";
    });
}

let source;

function applyView(data) {
    if (store.state.privateId !== null || data.conversation.id !== store.state.conversationId) {
        return;
    }

    store.set((state) => ({ view: mergeView(state.view, data), missing: null }));
}

/** PiP's conversation, for its panel (`pip.js`): the same view, from a view of its own beside the session's. */
function applyPipView(data) {
    store.set((state) => ({ pipView: mergeView(state.pipView, data) }));
}

/** A view after an update from the server: the full view, or what changed since the last one. */
function mergeView(current, data) {
    const base =
        data.full || current.conversation?.id !== data.conversation.id ? emptyView() : current;
    const entries = new Map(base.entries);

    for (const entry of data.entries) {
        entries.set(entry.id, entry);
    }

    const order = data.order ?? base.order;

    if (data.order) {
        const keep = new Set(data.order);

        for (const id of entries.keys()) {
            if (!keep.has(id)) {
                entries.delete(id);
            }
        }
    }

    return {
        ...base,
        conversation: data.conversation,
        entries,
        order,
        live: data.live,
        agent: data.agent,
        stats: data.stats,
        clients: data.clients,
        viewers: data.viewers,
        approvals: data.approvals,
        // The server sends these again only when they change: a missing one keeps its last value.
        inbox: data.inbox ?? base.inbox,
        artifacts: data.artifacts ?? base.artifacts,
        subagents: data.subagents ?? base.subagents,
        authors: data.authors ?? base.authors,
        reactions: data.reactions ?? base.reactions,
        pins: data.pins ?? base.pins,
        turns: data.turns ?? base.turns,
        decisions: data.decisions ?? base.decisions,
        plan: data.plan ?? base.plan,
        schedules: data.schedules ?? base.schedules,
        // Version-one saved rounds are deliberately not part of comment-first reviews.
        reviews: Array.isArray(data.reviews)
            ? { threads: [], rev: 0 }
            : (data.reviews ?? base.reviews),
        // No goal is null, which the server sends too: only a missing field keeps the last value.
        goal: data.goal === undefined ? base.goal : data.goal,
        // The session's PR watch, or null: the same.
        watch: data.watch === undefined ? base.watch : data.watch,
        // Why subagents' reports wait (a spend limit), or null when none do: the subagents bar says it.
        subagentsHeld: data.subagentsHeld === undefined ? base.subagentsHeld : data.subagentsHeld,
        // What the folder has checked out: `{ branch }` or `{ detached }`, and null outside a repository.
        branch: data.branch === undefined ? base.branch : data.branch,
    };
}

/** The `moving` marks that a session list has not caught up with yet: it still shows those sessions where they were. */
export function stillMoving(moving, sessions) {
    const next = { ...moving };

    for (const session of sessions) {
        if (next[session.id] === Boolean(session.archived)) {
            delete next[session.id];
        }
    }

    return next;
}

/** Who hears extensions' events: `extension-ui.js`, which imports this module and so cannot be imported here. */
const extensionListeners = new Set();

/** Hear the events extension modules send their browser modules: `{ module, event, data }`. */
export function onExtensionEvent(listener) {
    extensionListeners.add(listener);

    return () => extensionListeners.delete(listener);
}

// Keep the document's revision, not the last received hello: a hidden tab can miss reload broadcasts.
let webRevision = document.querySelector('meta[name="pocket-web-revision"]')?.content;
let reloading = false;

function requestReload() {
    if (!reloading) {
        reloading = true;
        // Message/editor drafts survive; unsent attachments and an open sign-in may not.
        setTimeout(() => {
            // beforeunload may let a dirty editor decline navigation. Only deduplicate pending attempts.
            reloading = false;
            location.reload();
        }, 150);
    }
}

function reconcileWeb(server) {
    if (!server?.webRevision) {
        return;
    }

    if (webRevision && webRevision !== server.webRevision) {
        requestReload();
    } else {
        webRevision = server.webRevision;
    }
}

/** What the server sends, by event name. Both transports deliver the same events. */
const handlers = {
    hello: (data) => {
        reconcileWeb(data.server);
        store.set({
            me: data.user,
            users: data.users,
            folderFavorites: data.folderFavorites ?? [],
            models: data.models,
            guard: data.guard,
            server: data.server,
            // Every theme folder (`theme.js`): an older server lists none.
            themeList: Array.isArray(data.themes) ? data.themes : [],
            // This connection's id, which peek lists name (`peeks.js`). `GET /api/me` answers without one.
            ...(data.connection === undefined ? {} : { streamId: data.connection }),
        });
        recoverSubmitAttempts();
        recoverHandoffInputs();
    },
    sessions: (sessions) => {
        store.set((state) => ({
            sessions,
            sessionsLoaded: true,
            moving: stillMoving(state.moving, sessions),
        }));
        handoffSessionsChanged(sessions);
    },
    "folder-favorites": (folderFavorites) => store.set({ folderFavorites }),
    projects: (data) => store.set({ projects: data.projects, projectsLoaded: true }),
    models: (models) => store.set({ models }),
    // A theme folder came, went, or changed (`theme.js` loads its new version).
    themes: (themeList) => store.set({ themeList }),
    // Every subagent in every session, while this tab shows the subagents board (`subagents-board.js`).
    subagents: (agents) => store.state.board && store.set({ boardAgents: agents }),
    view: applyView,
    // This person's PiP: its conversation, whether it works, and when it last answered (`pip.js`); null for none.
    pip: (pip) => store.set({ pip }),
    // PiP's conversation, while this tab's PiP panel is open.
    pipview: applyPipView,
    chat: applyChat,
    presence: (data) =>
        data.conversationId === store.state.conversationId && store.set({ presence: data.people }),
    notes: (data) =>
        data.conversationId === store.state.conversationId &&
        store.set({ notes: { text: data.text, rev: data.rev, by: data.by, at: data.at } }),
    browser: (data) =>
        data.conversationId === store.state.conversationId && store.set({ browser: data }),
    // Another session as its peek tile shows it (`peeks.js`): kept after it scrolls away, as the tile's last look.
    peek: (data) =>
        store.set((state) => ({ peeks: { ...state.peeks, [data.conversationId]: data } })),
    users: (users) => store.set({ users }),
    // Pi's lessons changed somewhere: a Memory sheet or menu that shows them fetches them again (`sheets/memory.js`).
    memory: () => store.set((state) => ({ memoryRev: (state.memoryRev ?? 0) + 1 })),
    missing: (data) => store.set({ missing: data.message }),
    // An event an extension module sent its browser module (`extension-ui.js`).
    ext: (data) => {
        for (const listener of extensionListeners) {
            listener(data);
        }
    },
    // A notice may link to a conversation, such as a mention elsewhere: tapping it goes there.
    notice: (data) => {
        const id = notify(
            data.level,
            data.message,
            data.link
                ? () =>
                      navigate(data.link.conversationId, {
                          sheet: data.link.sheet ? { type: data.link.sheet } : null,
                      })
                : undefined,
        );

        // A mention's: reading that chat takes it down.
        if (data.link?.sheet === "chat") {
            chatNotices.set(id, data.link.conversationId);
        }
    },
    auth: (data) => handleAuth(data),
    closing: () => store.set({ connection: "closed" }),
    reload: requestReload,
};

/**
 * What this code understands of the server's updates, sent with each connection. 2: it keeps the queue when an update
 * leaves it out. The server sends a tab whose code names none (older code, as a tab asleep through an update keeps)
 * the queue with each update.
 */
const PROTOCOL = 2;
const TRANSPORT_KEY = "pocket.transport";
const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
/** After an event stream stalls on this address, poll for a day, then try the stream again: one slow start is not forever. */
const POLL_FOR_MS = 24 * 60 * 60_000;

const pollHere = () => {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "";

    // Saved before the choice had a time: a choice made now.
    if (saved === "poll") {
        localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
    }

    const [mode, at] = (localStorage.getItem(TRANSPORT_KEY) ?? "").split(":");

    return mode === "poll" && Date.now() - Number(at) < POLL_FOR_MS;
};

/** Event stream reconnects in a row that the browser gave up on, for the pause before the next one. */
let streamRetries = 0;

const connected = () => store.state.connection !== "open" && store.set({ connection: "open" });

let foreground = true;
const awake = () =>
    foreground && document.visibilityState !== "hidden" && navigator.onLine !== false;

/** Release the transport, not the current view/drafts. Old callbacks must lose ownership before close. */
function suspend() {
    const previous = source;

    source = null;
    previous?.close();
    store.set({ connection: "closed" });
}

export function connect() {
    suspend();

    if (!awake()) {
        return;
    }

    store.set({ connection: "connecting" });
    const id = store.state.conversationId;
    const query = `tab=${encodeURIComponent(TAB)}&p=${PROTOCOL}${id === null ? "" : `&c=${id}`}`;

    source = pollHere() && !local ? pollEvents(query) : streamEvents(query);
}

// A page kept for Back and Forward stays alive, frozen, and so would its stream: each holds one of the few connections a
// browser makes to a server, and after a handful nothing else loads. It closes on leaving and reconnects on return.
addEventListener("pagehide", () => {
    foreground = false;
    clearTimeout(startRetry);
    suspend();
});
addEventListener("pageshow", (event) => {
    foreground = true;

    if (event.persisted) {
        resume();
    }
});
addEventListener("offline", () => {
    clearTimeout(startRetry);
    suspend();
});
addEventListener("online", () => resume());

function resume() {
    if (!awake() || source) {
        return;
    }

    if (store.state.me) {
        connect();
    } else if (store.state.me === undefined) {
        start();
    }
}

/** Server-sent events: one long response the server writes to as things change. */
function streamEvents(query) {
    const events = new EventSource(`/api/events?${query}`);
    /** The first batch arrived whole: the session's view, or the session list when no session is open. */
    let settled = false;
    const settles = query.includes("&c=") ? ["view", "missing"] : ["sessions"];
    let retry;
    const connection = {
        close() {
            clearTimeout(fallback);
            clearTimeout(retry);
            events.close();
        },
    };
    // Some tunnels hold the stream back. A Cloudflare quick tunnel passes it on in 64 KiB blocks and keeps the rest, so
    // a long session's first view can stop partway after its small first events got through. The stream counts as
    // working only once that first batch is whole; otherwise poll instead, and remember that for this address.
    const fallback = local
        ? undefined
        : setTimeout(() => {
              if (settled || source !== connection) {
                  return;
              }

              localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
              connect();
          }, 6000);

    for (const [name, handler] of Object.entries(handlers)) {
        events.addEventListener(name, (event) => {
            if (source !== connection) {
                return;
            }

            if (settles.includes(name)) {
                settled = true;
            }

            handler(JSON.parse(event.data));
        });
    }

    events.onopen = () => {
        if (source !== connection) {
            return;
        }

        streamRetries = 0;
        connected();
    };

    events.onerror = async () => {
        if (source !== connection) {
            return;
        }

        store.set({ connection: "closed" });

        // EventSource retries by itself after a network error; a 401 needs a sign-in instead.
        try {
            await api("me");
        } catch (error) {
            if (source !== connection) {
                return;
            }

            if (error.status === 401) {
                connection.close();
                store.set({ me: null });

                return;
            }
        }

        // It gives up for good when a retry gets an answer other than 200, such as a tunnel's 502 while the server
        // restarts. Start a new stream after a pause that grows with each try.
        if (events.readyState === EventSource.CLOSED && source === connection) {
            // A stream that failed was not held back: no reason to switch this address to polling.
            clearTimeout(fallback);
            streamRetries++;
            retry = setTimeout(
                () => source === connection && connect(),
                Math.min(10_000, 1000 * streamRetries),
            );
        }
    };

    return connection;
}

/** Long polling: each request waits for events and returns them; the next one acknowledges what arrived. */
function pollEvents(query) {
    let session = null;
    let ack = 0;
    let stopped = false;
    let request = null;
    let retry;
    let wake;
    const connection = {
        close() {
            stopped = true;
            clearTimeout(retry);
            wake?.();
            request?.abort();

            if (session) {
                fetch(`/api/poll?session=${session}&close=1`, { keepalive: true }).catch(() => {});
            }
        },
    };

    (async () => {
        let failures = 0;

        while (!stopped) {
            request = new AbortController();

            try {
                const response = await fetch(
                    `/api/poll?${query}${session ? `&session=${session}&ack=${ack}` : ""}`,
                    { signal: request.signal, cache: "no-store" },
                );

                if (stopped || source !== connection) {
                    return;
                }

                if (response.status === 401) {
                    stopped = true;
                    store.set({ me: null });

                    return;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (stopped || source !== connection) {
                    return;
                }

                if (data.session !== session) {
                    // A new session (first poll, or the server restarted): it starts with hello and a full view.
                    session = data.session;
                    ack = 0;
                }

                failures = 0;
                connected();

                for (const item of data.events) {
                    if (item.seq <= ack) {
                        continue;
                    }

                    ack = item.seq;
                    handlers[item.event]?.(item.data);
                }
            } catch {
                if (stopped) {
                    return;
                }

                failures++;

                if (store.state.connection === "open") {
                    store.set({ connection: "closed" });
                }

                await new Promise((resolve) => {
                    wake = resolve;
                    retry = setTimeout(resolve, Math.min(10_000, 1000 * failures));
                });
            }
        }
    })();

    return connection;
}

/** Sign-ins that ended, or whose dialog was closed here: what the server still says about them shows nothing. */
const endedSignIns = new Set();

/** The dialog of a sign-in (`AuthDialog`), as the server's words about it come. */
function handleAuth(data) {
    if (endedSignIns.has(data.flowId)) {
        return;
    }

    if (data.step === "done") {
        endedSignIns.add(data.flowId);
    }

    store.set((state) => {
        const flow =
            state.auth?.flowId === data.flowId
                ? state.auth
                : {
                      flowId: data.flowId,
                      providerId: data.providerId,
                      // Its id when the server sends no name (one not restarted since an update).
                      providerName: data.providerName ?? data.providerId,
                      events: [],
                      prompt: null,
                      done: null,
                  };

        if (data.step === "prompt") {
            return { auth: { ...flow, prompt: { id: data.promptId, ...data.prompt } } };
        }

        if (data.step === "prompt-closed") {
            return { auth: flow.prompt?.id === data.promptId ? { ...flow, prompt: null } : flow };
        }

        if (data.step === "event") {
            return { auth: { ...flow, events: [...flow.events, data.event] } };
        }

        if (data.step === "done") {
            if (data.ok) {
                notify("info", `Signed in to ${data.providerName ?? data.providerId}.`);
            }

            return { auth: data.ok ? null : { ...flow, prompt: null, done: data } };
        }

        return {};
    });
}

/**
 * A sign-in's question was answered, and the server took the answer. The server's next words may have come first (the
 * next question, or the end, which closes the dialog or shows why it failed): the dialog waits for the provider only
 * while it still shows that sign-in asking that question.
 */
export function signInAnswered(flowId, promptId) {
    store.set((state) =>
        state.auth?.flowId === flowId && state.auth.prompt?.id === promptId
            ? { auth: { ...state.auth, prompt: null } }
            : {},
    );
}

/** A sign-in's dialog was closed: it stays closed, whatever the server still says about that sign-in. */
export function closeSignIn(flowId) {
    endedSignIns.add(flowId);
    store.set((state) => (state.auth?.flowId === flowId ? { auth: null } : {}));
}

export function navigate(conversationId, { replace = false, sheet = null, privateId = null } = {}) {
    const path =
        privateId !== null
            ? `/private/${encodeURIComponent(privateId)}`
            : conversationId === null
              ? "/"
              : `/s/${conversationId}`;

    if (location.pathname !== path || store.state.conversationId !== conversationId) {
        pushRoute(path, { replace });
    }

    // The subagents board and extensions' pages show in the conversation's place: going to one, even the one under it,
    // closes them.
    if (store.state.board || store.state.page) {
        store.set({ board: false, boardAgents: null, page: null });
    }

    // Its row tapped again counts too.
    opened(conversationId);

    if (
        store.state.conversationId === conversationId &&
        store.state.privateId === privateId &&
        source
    ) {
        if (sheet) {
            openSheet(sheet);
        }

        return;
    }

    store.set((state) => ({
        conversationId,
        privateId,
        ...(privateId !== null
            ? { sidebarTab: "private" }
            : conversationId !== null
              ? { sidebarTab: "sessions" }
              : {}),
        view: emptyView(),
        ...peopleFor(conversationId),
        ...panelsFor(conversationId),
        peopleAsk: { tab: null, highlight: null, n: state.peopleAsk.n },
        browser: null,
        history: null,
        transcriptFrom: null,
        missing: null,
        drawer: false,
        ...sheetChange(sheet, state),
    }));
    connect();
}

// Back or forward to another route. Back that only closes a layer (a sheet, a panel) is back.js's.
onRoute(() => {
    const id = routeConversation();
    const privateId = routePrivate();

    if (id !== store.state.conversationId || privateId !== store.state.privateId) {
        opened(id);
        store.set({
            conversationId: id,
            privateId,
            ...(privateId !== null
                ? { sidebarTab: "private" }
                : id !== null
                  ? { sidebarTab: "sessions" }
                  : {}),
            view: emptyView(),
            ...peopleFor(id),
            ...panelsFor(id),
            peopleAsk: { tab: null, highlight: null, n: store.state.peopleAsk.n },
            browser: null,
            history: null,
            transcriptFrom: null,
            missing: null,
            sheet: null,
            drawer: false,
        });
        connect();
    }
});

let startRetry;
let starting = false;

export async function start() {
    clearTimeout(startRetry);

    if (starting || !awake()) {
        return;
    }

    starting = true;

    try {
        const hello = await api("me");

        reconcileWeb(hello.server);
        store.set({
            me: hello.user,
            users: hello.users,
            models: hello.models,
            guard: hello.guard,
            server: hello.server,
            themeList: Array.isArray(hello.themes) ? hello.themes : [],
        });
        connect();
    } catch (error) {
        store.set({ me: error.status === 401 ? null : undefined });

        if (error.status !== 401 && awake()) {
            notify("error", `Server unreachable: ${error.message}`);
            startRetry = setTimeout(start, 3000);
        }
    } finally {
        starting = false;
    }
}

// ─── Commands ───────────────────────────────────────────────────────────

const current = () => store.state.conversationId;

export const actions = {
    /** `inlineFiles` attaches @ files; captured ids and receipts keep review sends on their thread. */
    submit: async (
        text,
        attachments,
        mode,
        inlineFiles = false,
        id = current(),
        requestId = uid(),
    ) => {
        const userId = store.state.me?.id;
        const epoch = handoffInputEpoch;
        // Busy/steering mode may change after an uncertain response; it is not a new human message.
        const payload = JSON.stringify([text, attachments ?? [], Boolean(inlineFiles)]);
        const tracked = userId !== undefined && submitScopeMatches(id, userId, epoch);
        let attempt = tracked
            ? submitAttempts.find(
                  (request) =>
                      request.sourceId === id &&
                      request.userId === userId &&
                      request.payload === payload,
              )
            : undefined;
        const fresh = attempt === undefined;

        if (tracked && fresh) {
            attempt = { sourceId: id, userId, payload, requestId };
            // Persist before dispatch, including the window where reload cannot know POST's outcome.
            saveSubmitAttempts([...submitAttempts, attempt]);
        }

        if (attempt?.receipt) {
            const result = attempt.receipt;

            forgetSubmitAttempt(attempt);
            acceptSubmitReceipt(id, userId, epoch, result);

            return result;
        }

        if (attempt && submitFlights.has(attempt)) {
            return submitFlights.get(attempt);
        }

        const send = (async () => {
            try {
                const result = await api(`c/${id}/submit`, {
                    text,
                    attachments,
                    mode,
                    requestId: attempt?.requestId ?? requestId,
                    ...(inlineFiles ? { inlineFiles } : {}),
                });

                if (attempt) {
                    forgetSubmitAttempt(attempt);
                }

                acceptSubmitReceipt(id, userId, epoch, result);

                // Acceptance, not the eventual tool result, clears the composer's draft.
                return result;
            } catch (error) {
                if (attempt && fresh && error.status >= 400 && error.status < 500) {
                    forgetSubmitAttempt(attempt);
                } else if (attempt && submitScopeMatches(id, userId, epoch)) {
                    // A later rejection cannot disprove a previously uncertain admission.
                    recoverSubmitAttempts();
                }

                throw error;
            } finally {
                if (attempt) {
                    submitFlights.delete(attempt);
                }
            }
        })();

        if (attempt) {
            submitFlights.set(attempt, send);
        }

        return send;
    },
    updateWorkItem: (id, patch) => api(`c/${id}/x/work-items/work-item`, patch),
    /** Run a command in the session's folder (`!`); `context: false` keeps it from Pi (`!!`). */
    shell: (command, context, requestId = uid()) =>
        api(`c/${current()}/shell`, { command, context, requestId }),
    stopShell: (taskId) => api(`c/${current()}/shell/${taskId}/stop`, {}),
    /** Run an extension's command; sending the same request id again finds the first run. */
    extensionCommand: (commandId, args, requestId = uid()) =>
        api(`c/${current()}/extension-commands`, { commandId, args, requestId }),
    /** A file or folder for the viewer. */
    view: (path, options) =>
        api(`c/${current()}/view?path=${encodeURIComponent(path)}`, undefined, options),
    /** What changed in the session's folder: git's uncommitted changes, and Pi's edits. */
    changes: (id = current()) => api(`c/${id}/changes`),
    /** Comment-first reviews capture their session so navigation cannot retarget a send. */
    reviewComment: (request, id = current()) => api(`c/${id}/reviews/comment`, request),
    resolveReviewThreads: (request, id = current()) => api(`c/${id}/reviews/resolve`, request),
    /** Scoped, read-only Changes access for everyone in the conversation, including viewers. */
    reviewChanges: (id = current()) => api(`c/${id}/reviews/changes`),
    reviewDiff: (id, path, options) =>
        api(`c/${id}/reviews/diff?path=${encodeURIComponent(path)}`, undefined, options),
    reviewContext: (id, path, options) =>
        api(`c/${id}/reviews/context?path=${encodeURIComponent(path)}`, undefined, options),
    branches: () => api(`c/${current()}/branches`),
    switchBranch: (target) => api(`c/${current()}/branch`, target),
    /** Undo the uncommitted changes to one file. */
    revert: (path) => api(`c/${current()}/changes/revert`, { path }),
    abort: () => api(`c/${current()}/abort`, {}),
    chat: (text, quote) =>
        api(`c/${current()}/chat`, {
            text,
            requestId: uid(),
            ...(quote ? { quote: { entryId: quote.entryId } } : {}),
        }),
    react: (entryId, emoji) => api(`c/${current()}/react`, { entryId, emoji }),
    pin: (target) => api(`c/${current()}/pin`, target),
    saveNotes: (text, rev) => api(`c/${current()}/notes`, { text, rev }),
    turns: (action, to) => api(`c/${current()}/turns`, { action, ...(to ? { to } : {}) }),
    setAccess: (userId, patch) => api(`users/${encodeURIComponent(userId)}`, patch),
    withdraw: (submissionId) => api(`c/${current()}/withdraw`, { submissionId }),
    editQueued: (submissionId, text, expectedText) =>
        api(`c/${current()}/edit-queued`, { submissionId, text, expectedText }),
    configure: (change) => api(`c/${current()}/configure`, change),
    /** The owner's model and thinking level for new sessions, `{ provider, modelId, thinkingLevel }`; null clears it. */
    setDefaultModel: (choice) => api("settings", { defaultModel: choice }),
    compact: (instructions) => api(`c/${current()}/compact`, { instructions }),
    reset: (note) => api(`c/${current()}/reset`, { note }),
    setInstructions: (text) => api(`c/${current()}/instructions`, { text }),
    /** A new session with this one's history through `entryId`. */
    fork: (entryId, { worktree = false } = {}) =>
        api(`c/${current()}/fork`, { entryId, ...(worktree ? { worktree } : {}) }),
    /** Send a message to Pi again in a fork that ends just before it: `{ text }` edits it, `{ model }` picks another model. */
    resend: (entryId, change = {}) => api(`c/${current()}/resend`, { entryId, ...change }),
    setPlan: (on) => api(`c/${current()}/plan`, { on }),
    approvePlan: () => api(`c/${current()}/plan`, { approve: true }),
    prompts: () => api(`c/${current()}/prompts`),
    trust: () => api(`c/${current()}/trust`),
    /** `trust`, `trust-parent`, or `distrust`, as Pi's `/trust` offers them. */
    setTrust: (choice) => api(`c/${current()}/trust`, { choice }),
    /** Pi's sessions from the terminal on this machine; one of them to look at; and one continued as a new session. */
    piSessions: (query = "") =>
        api(query === "" ? "pi-sessions" : `pi-sessions?q=${encodeURIComponent(query)}`),
    piSession: (path) => api(`pi-sessions/preview?path=${encodeURIComponent(path)}`),
    continuePiSession: (request) => api("pi-sessions/continue", request),
    /** `when` says when, then what Pi gets: `in 2h check the deploy`. Clock times are this device's. */
    schedule: (when) =>
        api(`c/${current()}/schedules`, {
            when,
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
    cancelSchedule: (id) => api(`c/${current()}/schedules/${encodeURIComponent(id)}/cancel`, {}),
    setGoal: (command) => api(`c/${current()}/goal`, { command }),
    removeWorktree: (force) => api(`c/${current()}/worktree`, { remove: true, force }),
    clearGoal: () => api(`c/${current()}/goal`, { clear: true }),
    /** Watch the session's pull request: its branch's, or `pr` (a number or address). */
    watchPr: (pr) => api(`c/${current()}/watch`, pr ? { pr } : {}),
    unwatchPr: () => api(`c/${current()}/watch`, { stop: true }),
    approve: (id, allow) => api(`approvals/${encodeURIComponent(id)}`, { allow }),
    /** Project defaults are resolved server-side; an explicit cwd overrides them. */
    createSession: (cwd, { worktree = false, location, ...organization } = {}) =>
        api("sessions", {
            cwd,
            ...(location !== undefined ? { location } : {}),
            ...(worktree ? { worktree } : {}),
            ...(projectsAvailable() ? { requestId: uid(), ...organization } : {}),
        }),
    loadProjects: async () => {
        const data = await api("projects");

        store.set({ projects: data.projects, projectsLoaded: true });

        return data;
    },
    createProject: (request) => api("projects", { requestId: uid(), ...request }),
    updateProject: (id, patch) => api(`projects/${encodeURIComponent(id)}`, patch),
    updateSession: (id, patch) => api(`sessions/${id}`, patch),
    upload: (file) => api(`c/${current()}/upload?name=${encodeURIComponent(file.name)}`, file),
    fullEntry: (entryId) => api(`c/${current()}/entry/${entryId}`),
    history: (before) => api(`c/${current()}/history?before=${before}`),
};

/** Entries that show as transcript rows. Tool results show inside their call's card instead. */
export const isRow = (entry) =>
    ["user", "assistant", "compaction", "reset", "shell", "command", "note", "fromPi"].includes(
        entry.kind,
    );

/**
 * Show the transcript from this entry down when it is above the rows shown now, as for a jump to a pinned or quoted
 * message. Compares places in the transcript, not ids: after a compaction, the summary comes first with the newest id.
 */
export function revealEntry(entryId) {
    const { view, transcriptFrom } = store.state;

    if (transcriptFrom === null) {
        return;
    }

    const ids = view.order.filter((id) => {
        const entry = view.entries.get(id);

        return entry !== undefined && isRow(entry);
    });
    const at = ids.indexOf(entryId);
    const from = ids.indexOf(transcriptFrom);

    if (at !== -1 && (from === -1 || at < from)) {
        store.set({ transcriptFrom: entryId });
    }
}

// ─── The People panel ──────────────────────────────────────────────────────────────

/** Wide enough for the session list, the conversation, and a panel beside it: where the Browser panel docks too. */
const PEOPLE_DOCK = matchMedia("(min-width: 1100px)");

/**
 * Panels (People, Browser, Files) dock beside the conversation now; narrower, the Browser panel and the Files tile cover
 * the screen, and back closes them. A change re-renders (below).
 */
export const panelsBeside = () => PEOPLE_DOCK.matches;

/** The People panel shows beside the conversation now. */
export function peopleDocked(state = store.state) {
    return (
        state.peopleOpen &&
        PEOPLE_DOCK.matches &&
        Boolean(state.server?.chat) &&
        state.conversationId !== null &&
        !state.missing
    );
}

/**
 * What showing a sheet changes. On wide screens the chat docks beside the conversation instead, as the People panel, and
 * takes the Browser panel's place: both beside the conversation leave it too narrow.
 */
function sheetChange(sheet, state) {
    if (sheet?.type !== "chat" || !PEOPLE_DOCK.matches) {
        return { sheet };
    }

    return {
        sheet: null,
        peopleOpen: true,
        browserOpen: false,
        filesOpen: false,
        peopleAsk: {
            tab: sheet.tab ?? null,
            highlight: sheet.highlight ?? null,
            n: state.peopleAsk.n + 1,
        },
    };
}

/**
 * The Files tile shows now: asked for, in a conversation, and not in the Browser panel's place (one panel at a time).
 * Viewers get scoped Changes reviews; the tile keeps its file tree and editor restricted to people who can steer.
 */
export function filesShown(state = store.state) {
    // `browserAvailable()` (browser.js), which imports this module.
    const browsing =
        state.browserOpen && state.server?.extensions?.includes("pocket-browser") === true;

    return (
        state.filesOpen &&
        state.conversationId !== null &&
        !state.missing &&
        (state.me?.role !== "viewer" || state.server?.localReviews >= 2) &&
        !browsing
    );
}

/** Open a person's review from People, using the same per-thread Files panel and Back stack. */
export function revealReviewReviewer(userId) {
    const { conversationId, server, reviewFocus } = store.state;

    if (conversationId === null || !(server?.localReviews >= 2)) {
        return;
    }

    closePeople();
    store.set({
        filesOpen: true,
        filesTab: "changes",
        filesAsk: { tab: "changes", at: Date.now() },
        browserOpen: false,
        drawer: false,
        sheet: null,
        reviewFocus: { conversationId, userId, n: (reviewFocus?.n ?? 0) + 1 },
    });
}

/** Hide the People panel. Showing it is `openSheet({ type: "chat" })`, which docks it on wide screens. */
export function closePeople() {
    // Its active border goes to the conversation, not nowhere.
    if (document.documentElement.dataset.focus === "people-panel") {
        document.documentElement.dataset.focus = "pane";
    }

    store.set({ peopleOpen: false });
}

let chatLogs = 0;

/** A chat log is on screen, as the People sheet's or panel's Chat tab: call when it shows, and what it returns when it goes. */
export function chatLogShown() {
    chatLogs++;

    return () => {
        chatLogs--;
    };
}

// A window widened with the chat open as a sheet docks it. One narrowed hides the panel until it is wide again.
PEOPLE_DOCK.addEventListener("change", () => {
    const { sheet } = store.state;

    if (PEOPLE_DOCK.matches && sheet?.type === "chat") {
        openSheet(sheet);
    } else {
        store.set({});
    }
});

export function openSheet(sheet) {
    store.set((state) => ({ ...sheetChange(sheet, state), drawer: false }));
}

/**
 * Put text into the message box to Pi (after what is there: on a new paragraph, or with `inline`, after a space), and
 * files to attach, and close any sheet so it shows.
 */
export function insertIntoComposer(text, files = [], { inline = false } = {}) {
    store.set((state) => ({
        sheet: null,
        composerInsert: { text, files, inline, n: (state.composerInsert?.n ?? 0) + 1 },
    }));
}

/** Open the chat to discuss a transcript message: the next chat message quotes it. */
export function discuss(entryId, text) {
    store.set((state) => ({
        chatQuote: { entryId, text },
        ...sheetChange({ type: "chat" }, state),
        drawer: false,
    }));
}

// Tell the server when this tab is hidden or shown: others see "away", and push notifications only reach hidden tabs.
let lastVisible = null;

function reportVisibility() {
    const visible = document.visibilityState === "visible";

    if (visible === lastVisible || !collab()) {
        return;
    }

    lastVisible = visible;
    api("visibility", { tab: TAB, visible }).catch(() => {});
}

document.addEventListener("visibilitychange", () => {
    reportVisibility();

    if (!awake()) {
        clearTimeout(startRetry);
        suspend();
    } else {
        resume();
    }
});
store.subscribe((state) => {
    // Report again after each (re)connect: the server starts every new connection as visible.
    if (state.connection !== "open") {
        lastVisible = null;
    } else if (lastVisible === null && document.visibilityState !== "visible") {
        reportVisibility();
    }
});

export function closeSheet() {
    store.set({ sheet: null });
}

// Per-conversation composer drafts survive reloads, including the automatic ones after a live edit.
const draftRevisions = new Map();

export const drafts = {
    get: (id) => localStorage.getItem(`pocket.draft.${id ?? "home"}`) ?? "",
    revision: (id) => draftRevisions.get(id) ?? 0,
    set: (id, text) => {
        // Even edit/undo back to identical text is a newer draft than an in-flight submission.
        draftRevisions.set(id, drafts.revision(id) + 1);

        if (text) {
            localStorage.setItem(`pocket.draft.${id ?? "home"}`, text);
        } else {
            localStorage.removeItem(`pocket.draft.${id ?? "home"}`);
        }
    },
};
