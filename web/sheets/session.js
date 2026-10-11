// Session creation/import and the separate held-row actions share this module, not a sheet contract.
import { useEffect, useState } from "preact/hooks";
import { selectFromList, setArchived } from "../sessions.js";
import {
    canSteer,
    closeSheet,
    insertIntoComposer,
    isUnread,
    openSheet,
    projectsAvailable,
    setUnread,
    store,
} from "../store.js";
import { isPinned, togglePin } from "../theme.js";
import { html, item, Sheet } from "../ui.js";
import { FolderPicker } from "./folder.js";
import { ImportPanel } from "./import.js";
import { ProjectSessionPanel } from "./session-projects.js";

/**
 * What a finger held on a row offers: pin it, mark it unread (or read), archive it or bring it back, or select it to
 * act on more at once.
 */
export function SessionActions({ id }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const steer = canSteer();

    const then = (run) => () => {
        closeSheet();
        run();
    };

    return html`<${Sheet} title=${session.title ?? "New session"} onClose=${closeSheet}>
        <div class="sheet-list">
            ${
                !session.archived &&
                item(
                    isPinned(id) ? "Unpin from the top" : "Pin to the top",
                    then(() => togglePin(id)),
                    "this browser",
                )
            }
            ${
                !session.archived &&
                item(
                    isUnread(id) ? "Mark read" : "Mark unread",
                    then(() => setUnread(id, !isUnread(id))),
                    "this browser",
                )
            }
            ${
                steer &&
                item(
                    session.archived ? "Unarchive" : "Archive",
                    then(() => setArchived([id], !session.archived)),
                )
            }
            ${item(
                "Select",
                then(() => selectFromList(id)),
                "then tap others to add them",
            )}
        </div>
    <//>`;
}

const TABS = [
    { id: "new", label: "Start new" },
    { id: "import", label: "Import" },
];

export function NewSessionSheet({
    tab = "new",
    initialPreview = null,
    projectId,
    goalId,
    cwd,
    continuation,
}) {
    const owner = store.state.me?.role === "owner";
    const active = owner && tab === "import" ? "import" : "new";
    const [visited, setVisited] = useState(() => new Set([active]));
    const [busy, setBusy] = useState(false);

    // Mount each flow on first use, then keep its folder options or import draft across tab switches.
    useEffect(() => {
        setVisited((previous) =>
            previous.has(active) ? previous : new Set([...previous, active]),
        );
    }, [active]);

    const select = (id) => {
        if (!busy) {
            openSheet({ ...store.state.sheet, type: "new-session", tab: id });
        }
    };

    const onKeyDown = (event) => {
        const index = TABS.findIndex((each) => each.id === active);
        let next;

        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            next = TABS[(index + 1) % TABS.length].id;
        } else if (event.key === "Home") {
            next = "new";
        } else if (event.key === "End") {
            next = "import";
        } else {
            return;
        }

        event.preventDefault();

        if (!busy) {
            select(next);
            event.currentTarget.querySelector(`#session-tab-${next}`).focus();
        }
    };

    return html`<${Sheet} title="New Session" class="new-session-sheet" onClose=${closeSheet}>
        ${
            owner &&
            html`<div
                class="session-tabs new-session-tabs"
                role="tablist"
                aria-label="Session source"
                onKeyDown=${onKeyDown}
            >
                ${TABS.map(
                    ({ id, label }) =>
                        html`<button
                            key=${id}
                            id=${`session-tab-${id}`}
                            type="button"
                            role="tab"
                            class=${active === id ? "on" : ""}
                            aria-selected=${active === id}
                            aria-controls=${`session-panel-${id}`}
                            tabindex=${active === id ? 0 : -1}
                            disabled=${busy}
                            onClick=${() => select(id)}
                        >
                            ${label}
                        </button>`,
                )}
            </div>`
        }
        <section
            id="session-panel-new"
            class="new-session-panel"
            role=${owner ? "tabpanel" : undefined}
            aria-labelledby=${owner ? "session-tab-new" : undefined}
            hidden=${active !== "new"}
        >
            ${
                (active === "new" || visited.has("new")) &&
                (projectsAvailable()
                    ? html`<${ProjectSessionPanel}
                        projectId=${projectId}
                        goalId=${goalId}
                        cwd=${cwd}
                        continuation=${continuation}
                        visible=${active === "new"}
                        onBusyChange=${setBusy}
                    />`
                    : html`<${FolderPicker} mode="new" />`)
            }
        </section>
        ${
            owner &&
            html`<section
                id="session-panel-import"
                class="new-session-panel"
                role="tabpanel"
                aria-labelledby="session-tab-import"
                hidden=${active !== "import"}
            >
                ${
                    (active === "import" || visited.has("import")) &&
                    html`<${ImportPanel}
                        initialPreview=${initialPreview}
                        visible=${active === "import"}
                        onBusyChange=${setBusy}
                        onCreated=${() => {
                            if (continuation?.type === "share") {
                                insertIntoComposer(
                                    continuation.share.text,
                                    continuation.share.files,
                                );
                            }
                        }}
                    />`
                }
            </section>`
        }
    <//>`;
}

// Keep the original creation-dialog export available to existing integrations.
export { NewSessionSheet as SessionSheet };
