// This session's git worktree: its branch, and removing it.
import { useState } from "preact/hooks";
import { actions, attempt, closeSheet, notify, store } from "../store.js";
import { html, Sheet, shortPath } from "../ui.js";
import { conversationLocation } from "../workspace-location.js";

/** A session's own git worktree: where it is, and removing it (its branch stays). */
export function WorktreeSheet() {
    const { view, server, me } = store.state;
    const owner = me?.role === "owner";
    const worktree = view.conversation?.worktree;
    const canForce = view.conversation?.workflow?.managed === false;
    const home = conversationLocation()?.kind === "ssh" ? undefined : server?.home;
    const [dirty, setDirty] = useState(false);
    const remove = (force) =>
        attempt(async () => {
            if (store.state.me?.role !== "owner") {
                return;
            }

            try {
                await actions.removeWorktree(force);
                closeSheet();
                notify("info", `Removed the worktree. The branch ${worktree.branch} stays.`);
            } catch (error) {
                if (
                    error.status !== 409 ||
                    error.message !== "The worktree has uncommitted changes."
                ) {
                    throw error;
                }

                setDirty(true);
            }
        });

    if (!worktree) {
        return html`<${Sheet} title="Worktree" onClose=${closeSheet}>
            <p class="muted">This session works in its folder, not in a worktree.</p>
        <//>`;
    }

    return html`<${Sheet} title="Worktree" onClose=${closeSheet}>
        <p>
            This session works on the branch <span class="mono">${worktree.branch}</span>, in a checkout of its own: its changes stay apart from <span class="mono">${shortPath(worktree.source, home)}</span>.
        </p>
        ${
            owner
                ? html`<p class="muted small">
                      Ask Pi to commit, merge, or open a pull request when it is done. Removing the worktree deletes its folder; the branch and its commits stay, and Pi works in the original folder again.
                  </p>`
                : html`<p class="muted small">Only the owner can remove this worktree or change the thread's working directory.</p>`
        }
        ${
            owner &&
            (dirty
                ? html`<div class="error-box small">
                    The worktree has uncommitted changes. Removing it anyway loses them.
                </div>
                ${
                    canForce
                        ? html`<button class="button wide" onClick=${() => remove(true)}>Remove anyway</button>`
                        : html`<p class="muted small">Keep or move the changes before removing this workflow’s worktree.</p>`
                }`
                : html`<button class="button wide" onClick=${() => remove(false)}>
                    Remove the worktree
                </button>`)
        }
    <//>`;
}
