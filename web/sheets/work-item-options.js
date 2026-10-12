// Compatibility entry point: Work Items use the same bounded desktop menu and touch sheet as other sidebar objects.
import { handoffsAvailable, store } from "../store.js";
import { html } from "../ui.js";
import { SidebarOptions } from "./sidebar-options.js";

export function WorkItemOptionsSheet({ id, at }) {
    const session = store.state.sessions.find((each) => each.id === id);

    if (!handoffsAvailable() || !session?.workItemId) {
        return null;
    }

    return html`<${SidebarOptions} kind="work-item" id=${id} at=${at} />`;
}
