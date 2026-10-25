// The open sheet: which component shows it. The sheets themselves are in web/sheets/, and a few beside their features
// (chat.js, notify.js, share.js).
import { ChatSheet } from "./chat.js";
import { HomeCreationSheet } from "./home.js";
import { ExtensionSheet, onExtensionsGone } from "./extension-ui.js";
import { ShareSheet } from "./share.js";
import { AgentModelPicker, NamedAgentSheet, NamedAgentsSheet } from "./named-agents.js";
import { BranchPicker } from "./sheets/branch.js";
import { FileSheet } from "./sheets/file.js";
import { FindSheet } from "./sheets/find.js";
import {
    galleryAvailable,
    GalleryEntrySheet,
    GalleryShareSheet,
    GallerySheet,
    GallerySourceSheet,
    GalleryUpdateSheet,
} from "./sheets/gallery.js";
import { ImportSheet, ShareImportSheet } from "./sheets/pi-sessions.js";
import { CwdSheet } from "./sheets/folder.js";
import { MemorySheet } from "./sheets/memory.js";
import { MenuSheet, PlacesSheet } from "./sheets/menu.js";
import { MessageSheet } from "./sheets/message.js";
import { ModelPicker } from "./sheets/model.js";
import { PipModelPicker } from "./sheets/pip.js";
import { InviteSheet } from "./sheets/people.js";
import { AuthDialog } from "./sheets/providers.js";
import { RunningSheet } from "./sheets/running.js";
import { HooksSheet } from "./sheets/hooks.js";
import { SchedulesSheet } from "./sheets/schedules.js";
import { SettingsSheet } from "./sheets/settings.js";
import { NewSessionSheet, SessionActions } from "./sheets/session.js";
import { ProjectSheet } from "./sheets/project.js";
import { SessionMoveSheet } from "./sheets/session-move.js";
import { SidebarOptions } from "./sheets/sidebar-options.js";
import { NamedAgentOptions } from "./sheets/named-agent-options.js";
import { ShortcutsSheet } from "./sheets/shortcuts.js";
import { TextSheet } from "./sheets/text.js";
import { ArtifactsSheet, ArtifactViewer, ImageViewer } from "./sheets/viewers.js";
import { piSessionsAvailable } from "./sheets/pi-sessions.js";
import { WorkItemLimitsSheet } from "./sheets/work-item-limits.js";
import { WorktreeSheet } from "./sheets/worktree.js";
import { TrustSheet } from "./trust.js";
import { AgentHeaderSheet } from "./topbar.js";
import { addLayer, goBack, removeLayer } from "./back.js";
import { actions, store } from "./store.js";
import { Boundary, html, SheetBack, SheetInfo, usePresence } from "./ui.js";

// ─── Back ─────────────────────────────────────────────────────────────────────────

// Legacy settings entry points share one popup and one history step.
const SETTINGS_TABS = {
    appearance: "appearance",
    providers: "providers",
    notifications: "notifications",
    extensions: "extensions",
    name: "account",
    people: "account",
    spend: "usage",
};

/** What tells sheets apart: the same one changing (its query, say) stays one step back. */
const sheetKey = (sheet) => {
    if (sheet.type === "agent-header") {
        return `agent-header:${sheet.userId}:${sheet.agentId}:${sheet.source}:${sheet.panel}`;
    }

    const session =
        sheet.type === "new-session" ||
        (sheet.type === "cwd" && sheet.mode === "new") ||
        (sheet.type === "import" && !sheet.fromPrivate);
    const type = session ? "new-session" : SETTINGS_TABS[sheet.type] ? "settings" : sheet.type;

    const id = sheet.entryId ?? sheet.id ?? sheet.pipId ?? "";

    // Member Options can open Work Item Options for the same thread without replacing its Back step.
    return type === "sidebar-options" ? `${type}:${sheet.kind}:${id}` : `${type}:${id}`;
};

/**
 * The sheets opened one from another, oldest first (the menu, then the model picker it opened): each is a step back,
 * so back from one shows the sheet before it. `{ key, sheet, layer }`.
 */
const trail = [];
/** The conversation the trail's sheets were opened in: another one (a notice's link, with its sheet) starts afresh. */
let trailIn = store.state.conversationId;

store.subscribe(({ sheet, conversationId }) => {
    if (!sheet || conversationId !== trailIn) {
        trailIn = conversationId;

        for (const step of trail.splice(0)) {
            removeLayer(step.layer);
        }
    }

    if (!sheet) {
        return;
    }

    const key = sheetKey(sheet);
    const at = trail.findIndex((step) => step.key === key);

    // The same sheet, or one opened before it, shown again: the steps after it are gone.
    if (at !== -1) {
        for (const step of trail.splice(at + 1)) {
            removeLayer(step.layer);
        }

        trail[at].sheet = sheet;

        return;
    }

    const step = { key, sheet, layer: null };

    step.layer = addLayer(() => {
        const index = trail.indexOf(step);

        if (index !== -1) {
            trail.splice(index);
        }

        store.set({ sheet: trail.at(-1)?.sheet ?? null });
    });
    trail.push(step);
});

// A module turned off: its sheets under the one open come out of the trail, with their steps back, so back never shows
// one of a module that is gone. Its sheet that is open closes (`extension-ui.js`), and the whole trail with it.
onExtensionsGone((gone) => {
    const went = trail.filter((each) => each.sheet.type === "ext" && gone(each.sheet.module));

    for (const step of went) {
        trail.splice(trail.indexOf(step), 1);
        removeLayer(step.layer);
    }
});

// ─── Focus ────────────────────────────────────────────────────────────────────────

/** What had focus when a sheet opened over the app: it has it again when the last sheet closes. */
let opener = null;
/** What last had focus outside the sheets and the launcher: a sheet the launcher opens goes back there. */
let lastFocus = null;

addEventListener("focusin", (event) => {
    if (!event.target.closest?.(".sheet-host, .launcher-overlay")) {
        lastFocus = event.target;
    }
});

store.subscribe(({ sheet, launcher }) => {
    if (sheet && !opener) {
        const active = document.activeElement;

        opener = active?.closest(".launcher-overlay") ? lastFocus : active;
    } else if (!sheet && opener) {
        const back = opener;
        const active = document.activeElement;

        opener = null;

        // Unless something else took focus meanwhile (a session the sheet opened), or a phone's keyboard would pop up.
        if (
            (active === null || active === document.body || active.closest(".sheet-host")) &&
            !launcher &&
            back.isConnected &&
            !back.closest(".sheet-host") &&
            !(
                matchMedia("(pointer: coarse)").matches &&
                back.matches("input, textarea, [contenteditable]")
            )
        ) {
            back.focus({ preventScroll: true });
        }
    }
});

/**
 * The open sheet, if any. A sheet that closes stays a moment longer, marked as leaving, so it can animate out; one sheet
 * replacing another swaps at once.
 */
export function Sheets() {
    const [sheet, leaving] = usePresence(store.state.sheet, 200);
    const auth = store.state.auth ? html`<${AuthDialog} />` : null;

    if (!sheet) {
        return auth;
    }

    // Only this setup needs retention across child sheets: it owns native form drafts and
    // identity-creation callbacks. The hidden layer has no focus, drag, Escape or Back handlers.
    const creation = trail.find((step) => step.sheet.type === "home-creation")?.sheet;
    const layers = creation && creation !== sheet ? [creation, sheet] : [sheet];

    return html`${layers.map((layer) => {
        const active = layer === sheet;
        const closing = active && leaving;

        return html`<div
            key=${sheetKey(layer)}
            class=${`sheet-host ${closing ? "leaving" : ""}`}
            hidden=${!active}
            inert=${!active || closing}
        >
            <${SheetBack.Provider} value=${active && trail.length > 1 ? goBack : null}>
                <${SheetInfo.Provider} value=${{ type: layer.type, closing: Boolean(closing) }}>
                    <${Boundary} reset=${layer}>${sheetBody(layer, active && !closing)}<//>
                <//>
            <//>
        </div>`;
    })}
        ${auth}`;
}

function sheetBody(sheet, active = true) {
    const { view, me } = store.state;
    let body = null;

    switch (sheet.type) {
        case "home-creation":
            body = html`<${HomeCreationSheet} sheet=${sheet} active=${active} />`;
            break;
        case "import":
            body = piSessionsAvailable()
                ? sheet.fromPrivate
                    ? html`<${ImportSheet}
                              initialPreview=${sheet.initialPreview}
                              fromPrivate=${true}
                          />`
                    : html`<${NewSessionSheet}
                              tab=${sheet.tab ?? "import"}
                              initialPreview=${sheet.initialPreview}
                          />`
                : null;
            break;
        case "named-agents":
            body = html`<${NamedAgentsSheet} />`;
            break;
        case "new-session":
            body = html`<${NewSessionSheet}
                tab=${sheet.tab}
                initialPreview=${sheet.initialPreview}
                projectId=${sheet.projectId}
                cwd=${sheet.cwd}
                continuation=${sheet.continuation}
            />`;
            break;
        case "project":
            body = html`<${ProjectSheet} projectId=${sheet.projectId} />`;
            break;
        case "named-agent":
            body = html`<${NamedAgentSheet} sheet=${sheet} />`;
            break;
        case "agent-header":
            body = html`<${AgentHeaderSheet} sheet=${sheet} />`;
            break;
        case "sidebar-options":
            body =
                sheet.kind === "named-agent"
                    ? html`<${NamedAgentOptions} sheet=${sheet} />`
                    : html`<${SidebarOptions}
                          kind=${sheet.kind}
                          id=${sheet.id}
                          at=${sheet.at}
                      />`;
            break;
        case "move-sessions":
            body = html`<${SessionMoveSheet} key=${sheet.ids.join(",")} ids=${sheet.ids} />`;
            break;
        case "settings":
        case "appearance":
        case "providers":
        case "notifications":
        case "extensions":
        case "name":
        case "people":
        case "spend":
            body = html`<${SettingsSheet}
                tab=${sheet.tab ?? SETTINGS_TABS[sheet.type] ?? "appearance"}
            />`;
            break;
        case "shortcuts":
            body = html`<${ShortcutsSheet} />`;
            break;
        case "model":
            body = sheet.agentId
                ? html`<${AgentModelPicker} sheet=${sheet} />`
                : html`<${ModelPicker} />`;
            break;
        case "pip-model":
            body = html`<${PipModelPicker} target=${sheet.target} agent=${sheet.agent} />`;
            break;
        case "work-item-limits":
            body = html`<${WorkItemLimitsSheet} sheet=${sheet} />`;
            break;
        case "branch":
            body = view.conversation ? html`<${BranchPicker} />` : null;
            break;
        case "cwd":
            body =
                sheet.mode === "new"
                    ? html`<${NewSessionSheet}
                        tab=${sheet.tab}
                        projectId=${sheet.projectId}
                        cwd=${sheet.cwd}
                        continuation=${sheet.continuation}
                    />`
                    : html`<${CwdSheet} mode=${sheet.mode} />`;
            break;
        case "artifacts":
            body = html`<${ArtifactsSheet} />`;
            break;
        case "viewer":
            body = view.conversation
                ? html`<${ArtifactViewer} id=${sheet.id} version=${sheet.version} />`
                : null;
            break;
        case "gallery":
            body = galleryAvailable() ? html`<${GallerySheet} />` : null;
            break;
        case "gallery-entry":
            body = galleryAvailable()
                ? html`<${GalleryEntrySheet} key=${sheet.id} name=${sheet.id} />`
                : null;
            break;
        case "gallery-source":
            body = galleryAvailable()
                ? html`<${GallerySourceSheet} key=${sheet.id} name=${sheet.id} />`
                : null;
            break;
        case "gallery-update":
            body = galleryAvailable()
                ? html`<${GalleryUpdateSheet} key=${sheet.id} name=${sheet.id} />`
                : null;
            break;
        case "gallery-share":
            body = galleryAvailable()
                ? html`<${GalleryShareSheet}
                      key=${sheet.id}
                      file=${sheet.id}
                      theme=${sheet.theme === true}
                  />`
                : null;
            break;
        // A sheet an extension's browser module added (`extension-ui.js`).
        case "ext":
            body = html`<${ExtensionSheet} sheet=${sheet} />`;
            break;
        case "image":
            body = html`<${ImageViewer} src=${sheet.src} alt=${sheet.alt} />`;
            break;
        case "invite":
            body = html`<${InviteSheet}
                session=${sheet.session ?? null}
                initialAsOwner=${sheet.owner ?? false}
            />`;
            break;
        case "menu":
            body = html`<${MenuSheet} places=${!sheet.fromPlaces} sheet=${sheet} />`;
            break;
        case "session":
            body = store.state.sessions.some((each) => each.id === sheet.id)
                ? html`<${SessionActions} id=${sheet.id} />`
                : null;
            break;
        case "places":
            body = view.conversation ? html`<${PlacesSheet} />` : null;
            break;
        case "chat":
            body = view.conversation ? html`<${ChatSheet} />` : null;
            break;

        case "share-import":
            body = html`<${ShareImportSheet} key=${sheet.id} id=${sheet.id} />`;
            break;

        case "rename": {
            const session = sheet.id
                ? store.state.sessions.find((each) => each.id === sheet.id)
                : view.conversation;

            body = session?.pipAgent
                ? html`<${NamedAgentSheet} sheet=${sheet} id=${session.id} />`
                : session
                  ? html`<${TextSheet}
                title="Rename"
                label="Session title"
                initial=${session.title ?? ""}
                submit=${(value) => actions.updateSession(session.id, { title: value })}
            />`
                  : null;
            break;
        }

        case "worktree":
            body = html`<${WorktreeSheet} />`;
            break;
        case "trust":
            body = view.conversation ? html`<${TrustSheet} />` : null;
            break;
        case "file":
            body = view.conversation
                ? html`<${FileSheet} key=${sheet.id} path=${sheet.id} line=${sheet.line} />`
                : null;
            break;
        case "find":
            body = view.conversation
                ? html`<${FindSheet} key=${view.conversation.id} initial=${sheet.query ?? ""} />`
                : null;
            break;
        case "running":
            body = html`<${RunningSheet} />`;
            break;
        case "schedules":
            body = view.conversation ? html`<${SchedulesSheet} />` : null;
            break;
        case "hooks":
            body = html`<${HooksSheet} />`;
            break;
        case "memory":
            body =
                sheet.conversationId !== undefined || view.conversation
                    ? html`<${MemorySheet}
                          draft=${sheet.draft ?? ""}
                          conversationId=${sheet.conversationId}
                          pendingOnly=${sheet.pendingOnly === true}
                      />`
                    : null;
            break;
        case "share":
            body = html`<${ShareSheet} share=${sheet.share} />`;
            break;
        case "message":
            body = view.conversation
                ? html`<${MessageSheet} key=${sheet.entryId} entryId=${sheet.entryId} />`
                : null;
            break;
        case "reset":
            body = html`<${TextSheet}
                title="New context"
                hint="Pi starts fresh: it no longer sees the messages so far, though everyone here still does."
                label="Handoff note (optional)"
                placeholder="e.g. We fixed the login bug; next is the signup form."
                multiline=${true}
                button="Start a new context"
                submit=${(value) => actions.reset(value)}
            />`;
            break;
        case "instructions":
            body = view.conversation?.pipAgent
                ? html`<${NamedAgentSheet} sheet=${sheet} id=${view.conversation.id} />`
                : html`<${TextSheet}
                      title="Instructions for Pi"
                      hint="Pi gets these with every message in this session, after its own instructions. Everyone here can see them. Leave empty for none."
                      label="Instructions"
                      initial=${view.agent?.instructions ?? ""}
                      placeholder="e.g. Use pnpm, not npm. Ask before adding dependencies."
                      multiline=${true}
                      submit=${(value) => actions.setInstructions(value)}
                  />`;
            break;
        case "compact":
            body = html`<${TextSheet}
                title="Compact context"
                label="What should the summary keep? (optional)"
                placeholder="e.g. the failing test names"
                multiline=${true}
                button="Compact"
                submit=${(value) => actions.compact(value)}
            />`;
            break;
    }

    return body;
}
