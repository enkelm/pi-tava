// pi-tava web app. No build step: edit a file under web/ and every open browser reloads.
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { canGoBack, goBack, replaceAddress, startHistory, useBack } from "./back.js";
import { BrowserPanel } from "./browser-panel.js";
import { browserAvailable, setBrowserOpen, toggleBrowser } from "./browser.js";
import { PeoplePanel } from "./chat.js";
import { Composer, openingByAlt } from "./composer.js";
import { FilesPanel, filesAvailable, setFilesOpen, toggleFiles } from "./files-panel.js";
import { ExtensionPage } from "./extension-ui.js";
import { startEdgeBack, startSwipes, useDragToClose } from "./gestures.js";
import { HomeCreationPage, useRoomyLayout } from "./home.js";
import { PhoneSessionList } from "./session-navigation.js";
import { ProjectView } from "./project-view.js";
import { Launcher } from "./launcher.js";
import { registerWorker, updateBadge } from "./notify.js";
import {
    PEEK_WIDE,
    PeekHost,
    PeekStrip,
    peekContext,
    peekTiles,
    peeksWanted,
    togglePeeks,
} from "./peeks.js";
import { closePip, openPip, PipHost, pipAvailable, togglePip } from "./pip.js";
import { Drawer, Rail, ResizeHandle, SessionList, toSessions } from "./sessions.js";
import { PrivatePane } from "./private.js";
// Loaded for what it does: it gives replies' Markdown the component for pages, images, and diffs in code blocks.
import "./rich.js";
import { takeShare } from "./share.js";
import { Sheets } from "./sheets.js";
import { SignIn } from "./signin.js";
import { SubagentsBoard } from "./subagents-board.js";
import {
    actions,
    attempt,
    canSteer,
    dismiss,
    filesShown,
    holdNotice,
    navigate,
    notify,
    openSheet,
    panelsBeside,
    peopleDocked,
    scoped,
    start,
    store,
    workspaceOrder,
} from "./store.js";
import { prefs, setPrefs, startTheme } from "./theme.js";
import { Transcript } from "./transcript.js";
import { startTerminalRendererPrefetch } from "./terminal-renderer-assets.js";
import { APPLE, Boot, BOTTOM_SHEETS, html, Icon, iconPath, usePresence } from "./ui.js";
import { toggleDictation } from "./voice.js";
import { rowIsOpen, rowOpenId } from "./work-items.js";
import { Topbar } from "./topbar.js";
import { AgentDraftPane } from "./agent-draft-pane.js";

/**
 * A notice, as a small tile: a state square in its level's color, the message, and a countdown line until it goes. A
 * tap dismisses it, or does what it offers (a chevron says so); on a phone, a swipe up puts it away.
 */
function Notice({ notice, leaving }) {
    const ref = useRef(null);
    const [pointed, setPointed] = useState(false);
    const [focused, setFocused] = useState(false);
    const held = (pointed || focused) && !leaving;

    // Its countdown, and the line that shows it, wait while it is being read or reached for.
    useEffect(() => holdNotice(notice.id, held), [held]);

    useDragToClose(ref, {
        dir: "up",
        onClose: () => dismiss(notice.id),
        enabled: BOTTOM_SHEETS.matches,
        // It fades as it goes, not the stack behind it.
        scrim: ref,
    });

    return html`<button
        ref=${ref}
        class=${`notice ${notice.level} ${notice.action ? "acts" : ""} ${held ? "held" : ""} ${leaving ? "leaving" : ""}`}
        data-part="notice"
        style=${`--life:${notice.life ?? 4500}ms`}
        onPointerEnter=${() => setPointed(true)}
        onPointerLeave=${() => setPointed(false)}
        onFocus=${() => setFocused(true)}
        onBlur=${() => setFocused(false)}
        onClick=${() => {
            dismiss(notice.id);
            notice.action?.();
        }}
    >
        <span class="notice-mark" aria-hidden="true"></span>
        <span class="notice-text">${notice.message}</span>
        <${Icon} name=${notice.action ? "chevron" : "close"} size=${14} />
    </button>`;
}

/** Notices: each slides in, counts down, and slides out when it goes. */
function Notices() {
    const { notices } = store.state;
    const [gone, setGone] = useState([]);
    const before = useRef(notices);

    useEffect(() => {
        const removed = before.current.filter(
            (notice) => !notices.some((each) => each.id === notice.id),
        );

        before.current = notices;

        if (removed.length === 0) {
            return;
        }

        setGone((list) => [...list, ...removed]);
        setTimeout(
            () => setGone((list) => list.filter((notice) => !removed.includes(notice))),
            160,
        );
    }, [notices]);
    const all = [
        ...notices,
        ...gone.filter((notice) => !notices.some((each) => each.id === notice.id)),
    ].sort((a, b) => a.id - b.id);

    if (all.length === 0) {
        return null;
    }

    return html`<div class="notices" data-part="notices" role="status" aria-live="polite">
        ${all.map(
            (notice) =>
                html`<${Notice}
                    key=${notice.id}
                    notice=${notice}
                    leaving=${!notices.includes(notice)}
                />`,
        )}
    </div>`;
}

/** The launcher, kept on screen a moment after it closes so it can fade out. */
function LauncherHost() {
    const [opening, setOpening] = useState({ n: 0, returnTo: document.activeElement });
    const wasOpen = useRef(Boolean(store.state.launcher));

    // Observe logical openings before batched renders: even a close/reopen in one task gets a fresh launcher.
    // Issue #62, reported by @arunsathiya: a retained, inert launcher must not reopen without its input focused.
    useLayoutEffect(
        () =>
            store.subscribe((state) => {
                const next = Boolean(state.launcher);

                if (next && !wasOpen.current) {
                    const target = document.activeElement;

                    setOpening((previous) => ({
                        n: previous.n + 1,
                        returnTo:
                            target === document.body || target?.closest(".launcher-overlay")
                                ? previous.returnTo
                                : target,
                    }));
                }

                wasOpen.current = next;
            }),
        [],
    );

    const [open, leaving] = usePresence(store.state.launcher ? opening : null, 150);

    useBack(Boolean(store.state.launcher), () => store.set({ launcher: false }));

    return open
        ? html`<${Launcher} key=${open.n} leaving=${leaving} returnTo=${open.returnTo} />`
        : null;
}

/**
 * The People panel, kept on screen a moment after it closes so it can slide out. Not when the Browser panel or the Files
 * tile takes its place.
 */
function PeopleHost({ shown, replaced }) {
    const [kept, leaving] = usePresence(shown || null, 180);

    if (kept === null || (leaving && replaced)) {
        return null;
    }

    return html`<${PeoplePanel} leaving=${leaving} />`;
}

/**
 * The Browser panel or the Files tile. Where it covers the conversation it is a screen pushed over it, kept a moment
 * after it closes so it can slide away; beside the conversation it goes at once.
 */
function PanelHost({ shown, panel }) {
    const [kept, leaving] = usePresence(shown || null, 240);
    const covering = shown && !panelsBeside();

    // Over the conversation, keys go to the panel (a dialog then, with Tab kept in it), unless something in it already
    // took them; when it goes, they go back to what had them before, unless something else took them meanwhile.
    useLayoutEffect(() => {
        if (!covering) {
            return undefined;
        }

        const opener = document.activeElement;
        const box = document.querySelector(".layout > :is(.files-tile, .browser):not(.leaving)");

        if (box && !box.contains(opener)) {
            box.focus({ preventScroll: true });
        }

        return () => {
            const active = document.activeElement;

            // Not into a text field on touch screens, where its keyboard would pop up.
            if (
                (active === null || active === document.body || box?.contains(active)) &&
                opener?.isConnected &&
                !box?.contains(opener) &&
                !(
                    matchMedia("(pointer: coarse)").matches &&
                    opener.matches("input, textarea, [contenteditable]")
                )
            ) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [covering]);

    if (kept === null || (leaving && panelsBeside())) {
        return null;
    }

    return html`<${panel} leaving=${leaving} />`;
}

function App() {
    const state = store.state;
    const roomy = useRoomyLayout();

    useEffect(() => {
        document.title = state.view.conversation?.title
            ? `${state.view.conversation.title} · pi-tava`
            : "pi-tava";
    }, [state.view.conversation?.title]);

    if (state.me === undefined) {
        return html`<${Boot}
                caption=${state.notices.some((notice) => notice.level === "error") ? "waiting for the server" : "starting"}
            />
            <${Notices} />`;
    }

    if (state.me === null) {
        return html`<${SignIn} /><${Notices} />`;
    }

    const inConversation = state.conversationId !== null;
    const inProject = state.projectId != null;
    // A phone-originated setup may become a roomy dialog on iPad. Do not mount a
    // second blank Home form underneath it; a real unfinished page keeps its own state.
    const creationOverHome =
        !state.homeCreation &&
        (state.sheet?.type === "home-creation" || state.sheet?.creationParent);
    const inAgentDraft =
        state.agentDraft !== null && state.me.role === "owner" && state.server?.privateAgents >= 4;
    const inPrivate = state.privateId !== null;
    const rail = prefs().sidebar === "rail";
    // The subagents board, or an extension's page, takes the conversation's place, and the panels beside it give it
    // their room.
    const board = !inPrivate && state.board;
    const page = !inPrivate && !board && state.page !== null;
    const placed = board || page;
    const browsing =
        inConversation && !placed && state.browserOpen && browserAvailable() && !state.missing;
    const filing = !placed && filesShown(state);
    const people = !placed && !browsing && !filing && peopleDocked(state);
    const peeking = !placed && peeksWanted(state);
    const tiles = peeking ? peekTiles(state) : [];
    const peekScope = peeking ? peekContext(state) : null;
    // The column takes the place beside the conversation when Browser and People leave it free; otherwise a strip,
    // which only shows when there are tiles.
    const peekColumn = peeking && PEEK_WIDE.matches && !browsing && !filing && !people;
    const atHome = !(inConversation || inAgentDraft || inPrivate || inProject || placed);

    return html`<div
        class=${`layout ${atHome ? "home" : ""} ${inPrivate ? "private-layout" : ""} ${state.me.role === "owner" && state.sidebarTab === "private" ? "private-sidebar" : ""} ${browsing ? "browsing" : ""} ${filing ? "filing" : ""}`}
        data-part="app"
    >
        ${
            roomy &&
            html`<aside class="sidebar window" data-part="sidebar">
                ${rail ? html`<${Rail} />` : html`<${SessionList} />`}
                ${!rail && html`<${ResizeHandle} />`}
            </aside>`
        }
        <div class=${`pane window ${placed ? "boarded" : ""}`} data-part="pane">
            ${!roomy && html`<${PhoneSessionList} key=${state.me.id} active=${atHome} />`}
            ${
                inPrivate
                    ? state.me.role === "owner"
                        ? html`<${PrivatePane} key=${state.me.id} id=${state.privateId} />`
                        : html`<header class="topbar private-topbar">
                              <button
                                  class="icon-button"
                                  aria-label="Back to sessions"
                                  onClick=${toSessions}
                              >
                                  <${Icon} name="back" />
                              </button>
                              <span>Private panes are owner-only.</span>
                          </header>`
                    : board
                      ? html`<${SubagentsBoard} />`
                      : page
                        ? html`<${ExtensionPage} key=${`${state.page.module}:${state.page.id}`} />`
                        : inAgentDraft
                          ? html`<${Topbar} />
                              ${peeking && !peekColumn && html`<${PeekStrip} tiles=${tiles} context=${peekScope} />`}
                              <${AgentDraftPane} key=${state.agentDraft.id} />`
                          : inConversation
                            ? html`<${Topbar} />
                                ${
                                    peeking &&
                                    (tiles.length > 0 || peekScope !== null) &&
                                    !peekColumn &&
                                    html`<${PeekStrip} tiles=${tiles} context=${peekScope} />`
                                }
                                <${Transcript} key=${state.conversationId} />
                                ${
                                    state.view.conversation &&
                                    !state.missing &&
                                    html`<${Composer} key=${state.conversationId} />`
                                }`
                            : inProject
                              ? html`<${ProjectView}
                                    key=${state.projectId}
                                    projectId=${state.projectId}
                                    onBack=${toSessions}
                                />`
                              : !creationOverHome &&
                                (roomy || state.homeCreation) &&
                                html`<${HomeCreationPage} key=${`${state.me.id}:${state.homeCreation?.id ?? "home"}`} />`
            }
        </div>
        ${
            (inConversation || inAgentDraft) &&
            html`<${PeekHost}
                shown=${peekColumn}
                tiles=${tiles}
                context=${peekScope}
                replaced=${browsing || filing || people}
            />`
        }
        <${PanelHost}
            key=${`browser:${state.conversationId}`}
            shown=${browsing}
            panel=${BrowserPanel}
        />
        <${PanelHost} key=${`files:${state.conversationId}`} shown=${filing} panel=${FilesPanel} />
        ${inConversation && html`<${PeopleHost} shown=${people} replaced=${browsing || filing} />`}
        <${Drawer} />
        <${PipHost} />
        <${Sheets} />
        <${LauncherHost} />
        <${Notices} />
    </div>`;
}

// ─── Windows and keys ───────────────────────────────────────────────────────────

/** Mark the active window on mouse hover, a tap, or keyboard focus. */
function focusWindow(event) {
    if (event.type === "pointerover" && event.pointerType !== "mouse") {
        return;
    }

    const win = event.target.closest?.(".window");

    if (!win) {
        return;
    }

    // By the window's part name, as themes know it: `sidebar`, `peeks`, `people-panel`, `browser-panel`, `files-panel`.
    const name =
        ["sidebar", "peeks", "people-panel", "browser-panel", "files-panel"].find((each) =>
            win.matches(`[data-part~="${each}"]`),
        ) ?? "pane";

    if (document.documentElement.dataset.focus !== name) {
        document.documentElement.dataset.focus = name;
    }
}

// The conversation's window has the focus until another takes it: `data-focus` always names one, for themes too.
document.documentElement.dataset.focus ??= "pane";
document.addEventListener("pointerover", focusWindow, true);
document.addEventListener("pointerdown", focusWindow, true);
document.addEventListener("focusin", focusWindow, true);

const typingIn = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const wide = () => matchMedia("(min-width: 768px)").matches;

/** Go to the session `by` places away in workspace order, wrapping around. */
function step(by) {
    const order = workspaceOrder();

    if (order.length === 0) {
        return;
    }

    const at = order.findIndex((session) => rowIsOpen(session, store.state.conversationId));
    const next = rowOpenId(order[(at + by + order.length) % order.length]);

    openingByAlt(next);
    navigate(next);
}

addEventListener("keydown", (event) => {
    if (event.isComposing || event.defaultPrevented) {
        return;
    }

    // Private owns Herdr's keys. Never turn terminal input into a Durable action.
    if (store.state.privateId !== null) {
        return;
    }

    if (event.key === "Alt") {
        document.documentElement.dataset.alt = "on";
    }

    // Cmd on Apple keyboards, where Ctrl+K and Ctrl+B edit text; Ctrl elsewhere.
    const mod = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const key = event.key.toLowerCase();

    if (!store.state.me) {
        return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "k") {
        event.preventDefault();
        store.set({ launcher: !store.state.launcher, drawer: false });

        return;
    }

    // Find in this session: the browser's own find misses the messages the transcript does not draw.
    if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        key === "f" &&
        store.state.view.conversation &&
        !store.state.launcher &&
        !store.state.board &&
        !store.state.page
    ) {
        event.preventDefault();
        openSheet({ type: "find" });

        return;
    }

    if (mod && !event.altKey && !event.shiftKey && key === "b") {
        event.preventDefault();

        if (wide()) {
            setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" });
        } else {
            store.set({ drawer: !store.state.drawer });
        }

        return;
    }

    // Option types characters on Apple keyboards, and AltGr does on many layouts: no Alt shortcuts there while typing.
    const altTypes = event.getModifierState?.("AltGraph") || (APPLE && typingIn(event.target));

    if (event.altKey && !event.ctrlKey && !event.metaKey && !altTypes) {
        const digit = /^Digit([1-9])$/.exec(event.code);

        if (digit) {
            const session = workspaceOrder()[Number(digit[1]) - 1];

            event.preventDefault();

            if (session) {
                const id = rowOpenId(session);

                openingByAlt(id);
                navigate(id);
            }

            return;
        }

        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
            event.preventDefault();
            step(event.code === "ArrowDown" ? 1 : -1);

            return;
        }

        if (event.code === "KeyN" && canSteer() && !scoped()) {
            event.preventDefault();
            openSheet({ type: "cwd", mode: "new" });

            return;
        }

        if (event.code === "KeyP" && store.state.server?.peeks === true) {
            event.preventDefault();
            togglePeeks();

            return;
        }

        if (event.code === "KeyT") {
            event.preventDefault();
            setPrefs({ showThinking: !prefs().showThinking });
            notify("info", `Show thinking: ${prefs().showThinking ? "on" : "off"}.`);

            return;
        }

        // The panels are not beside the subagents board, nor an extension's page.
        if (
            event.code === "KeyB" &&
            store.state.conversationId !== null &&
            !store.state.board &&
            !store.state.page &&
            browserAvailable()
        ) {
            event.preventDefault();
            toggleBrowser();

            return;
        }

        if (event.code === "KeyE" && !store.state.board && !store.state.page && filesAvailable()) {
            event.preventDefault();
            toggleFiles();

            return;
        }

        // PiP, the assistant over every screen; not under a sheet, where it would open unseen.
        if (event.code === "KeyA" && pipAvailable() && !store.state.sheet) {
            event.preventDefault();
            togglePip();

            return;
        }

        // Dictation into the message box in view: PiP's while it is open, else the session's.
        if (
            event.code === "KeyV" &&
            !store.state.sheet &&
            !store.state.launcher &&
            toggleDictation()
        ) {
            event.preventDefault();

            return;
        }
    }

    // Esc closes PiP first, unless a sheet or the launcher is over it: those close first.
    if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        store.state.pipOpen &&
        !store.state.sheet &&
        !store.state.launcher
    ) {
        event.preventDefault();
        closePip();

        return;
    }

    // Esc closes the Files tile or the Browser panel where it covers the conversation, as back does. What is inside
    // takes it first: a file open over the tree, the page in the panel, a field.
    const cover =
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !store.state.sheet &&
        !store.state.launcher &&
        !store.state.drawer &&
        document.querySelector(
            '.layout > [aria-modal="true"]:is(.files-tile, .browser):not(.leaving)',
        );

    if (cover) {
        event.preventDefault();

        if (cover.classList.contains("files-tile")) {
            setFilesOpen(false);
        } else {
            setBrowserOpen(false);
        }

        return;
    }

    if (event.key === "Escape" && !event.defaultPrevented) {
        stopOnSecondEscape();
    }

    if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !typingIn(event.target) &&
        !store.state.sheet &&
        !store.state.launcher
    ) {
        event.preventDefault();
        openSheet({ type: "shortcuts" });
    }
});
/** When Esc was last pressed while Pi worked: a second press soon after stops it. */
let escapedAt = 0;
/** The notice the first press shows. */
let escapeNotice = null;
const ESCAPE_TWICE_MS = 1500;

/** Esc twice stops Pi, as Esc does in other agents' terminals. Twice, since Esc also closes things and leaves fields. */
function stopOnSecondEscape() {
    const { view, sheet, launcher, board, page, drawer } = store.state;
    const stoppable = view.live?.busy || view.conversation?.workSupervisor?.status === "running";

    // Esc closes these first.
    if (sheet || launcher || board || page || drawer || !stoppable || !canSteer()) {
        return;
    }

    if (Date.now() - escapedAt < ESCAPE_TWICE_MS) {
        escapedAt = 0;
        // Pressed again: what it asked for is done.
        dismiss(escapeNotice);
        attempt(actions.abort);

        return;
    }

    escapedAt = Date.now();
    const notice = (escapeNotice = notify("info", "Press Esc again to stop Pi."));

    // Up only while a second press stops Pi.
    setTimeout(() => dismiss(notice), ESCAPE_TWICE_MS);
}

const altUp = () => delete document.documentElement.dataset.alt;

addEventListener("keyup", (event) => event.key === "Alt" && altUp());
addEventListener("blur", altUp);

// The whole tree re-renders from the store; Preact's diff keeps that cheap. Batched per microtask.
startTheme();
// Where the session list is not beside the conversation, a conversation opened straight away gets it under it, so back
// goes to the list rather than out of the app.
startHistory({ home: !wide() });
startEdgeBack();
// One hand on a phone: on the conversation, swipe right to go back and left for the Files tile; swipe up from the
// message box for the places.
startSwipes((where) => {
    const { conversationId, privateId, view, missing } = store.state;

    if (privateId !== null) {
        return { right: { path: iconPath("back"), label: "Private panes", run: toSessions } };
    }

    // The subagents board or an extension's page in the conversation's place (or the home screen's): right goes back,
    // as its × does.
    if (where === "board") {
        return { right: { path: iconPath("back"), label: "Back", run: goBack } };
    }

    if (conversationId === null || !view.conversation || missing) {
        return {};
    }

    if (where === "files") {
        return { right: { path: iconPath("back"), label: "Back", run: goBack } };
    }

    // Back to the list, or to the session before when that is where back goes.
    const toList = !canGoBack() || history.state?.pocket?.back === 1;

    return {
        right: {
            path: iconPath("back"),
            label: toList ? "Sessions" : "Back",
            run: () => (canGoBack() ? goBack() : toSessions()),
        },
        left: filesAvailable()
            ? { path: iconPath("folder"), label: "Files", run: () => setFilesOpen(true) }
            : null,
        up: () => openSheet({ type: "places" }),
    };
});
const root = document.getElementById("app");
let queued = false;

store.subscribe(() => {
    if (queued) {
        return;
    }

    queued = true;
    queueMicrotask(() => {
        queued = false;
        render(html`<${App} />`, root);
    });
});
render(html`<${App} />`, root);

// A notification's link can ask for the chat: `/s/12?chat=1`.
if (new URLSearchParams(location.search).has("chat")) {
    replaceAddress(location.pathname);
    openSheet({ type: "chat" });
}

// PiP's notifications open its panel, over whatever was open: `/?pip=1`. Opened once the server says PiP is here.
if (new URLSearchParams(location.search).has("pip")) {
    replaceAddress(location.pathname);
    const stop = store.subscribe(() => {
        if (store.state.server) {
            stop();
            openPip();
        }
    });
}

// The worker shows notifications and receives what other apps share; it needs a secure page (https or localhost).
registerWorker();
store.subscribe(updateBadge);
startTerminalRendererPrefetch(store);
start();
// Something shared from another app: the service worker kept it, and redirected here to choose where it goes.
const shared = new URLSearchParams(location.search).get("share");

if (shared !== null) {
    replaceAddress(location.pathname);
    takeShare(shared).then(
        (share) =>
            share
                ? store.set({ sheet: { type: "share", share } })
                : notify("error", "What was shared did not arrive. Share it again."),
        () => notify("error", "What was shared could not be read. Share it again."),
    );
}
