// One lazy phone list, retained across routes without redrawing its hidden rows on every reply.
import { Component } from "preact";
import { SessionList } from "./sessions.js";
import { html } from "./ui.js";

export class PhoneSessionList extends Component {
    visited = false;
    focused = null;

    shouldComponentUpdate(next) {
        return next.active || this.props.active;
    }

    getSnapshotBeforeUpdate(previous) {
        if (previous.active && !this.props.active && this.base?.contains(document.activeElement)) {
            this.focused = document.activeElement;
        }

        return null;
    }

    componentDidUpdate(previous) {
        if (
            this.props.active &&
            !previous.active &&
            this.focused?.isConnected &&
            this.base?.contains(this.focused) &&
            (document.activeElement === document.body || document.activeElement === null) &&
            !(
                matchMedia("(pointer: coarse)").matches &&
                this.focused.matches("input, textarea, [contenteditable]")
            )
        ) {
            this.focused.focus({ preventScroll: true });
        }
    }

    render({ active }) {
        this.visited ||= active;

        if (!this.visited) {
            return null;
        }

        return html`<div class="home-list" hidden=${!active} inert=${!active}>
            <${SessionList} home=${true} active=${active} />
        </div>`;
    }
}
