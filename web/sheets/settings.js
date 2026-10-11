// App settings: one popup, with categories in a sidebar or a scrolling phone tab row.
import { useEffect, useRef, useState } from "preact/hooks";
import { NotificationsSettings } from "../notify.js";
import { closeSheet, openSheet, store } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";
import { AccountSettings } from "./account.js";
import { AppearanceSettings } from "./appearance.js";
import { BrowserSettings } from "./browser-profiles.js";
import { ExtensionsSettings } from "./extensions.js";
import { ProvidersSettings } from "./providers.js";
import { SpendSettings } from "./spend.js";

const TABS = [
    { id: "appearance", label: "Appearance", icon: "palette", body: AppearanceSettings },
    { id: "providers", label: "Providers", icon: "key", body: ProvidersSettings },
    { id: "notifications", label: "Notifications", icon: "bell", body: NotificationsSettings },
    { id: "browser", label: "Browser", icon: "globe", body: BrowserSettings },
    { id: "extensions", label: "Extensions & safety", icon: "shield", body: ExtensionsSettings },
    { id: "account", label: "Account & access", icon: "users", body: AccountSettings },
    { id: "usage", label: "Usage & limits", icon: "pulse", body: SpendSettings },
];

export function SettingsSheet({ tab = "appearance" }) {
    const active = TABS.some((each) => each.id === tab) ? tab : "appearance";
    const [vertical, setVertical] = useState(() => matchMedia("(min-width: 700px)").matches);
    const [visited, setVisited] = useState(() => new Set([active]));
    const navigation = useRef(null);

    useEffect(() => {
        const media = matchMedia("(min-width: 700px)");
        const change = () => setVertical(media.matches);

        media.addEventListener("change", change);

        return () => media.removeEventListener("change", change);
    }, []);
    // Load a panel on its first visit, then retain its draft and scroll position across tab changes.
    useEffect(() => {
        setVisited((previous) =>
            previous.has(active) ? previous : new Set([...previous, active]),
        );
        navigation.current?.querySelector(`#settings-tab-${active}`)?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
        });
    }, [active, vertical]);
    const select = (id) => openSheet({ ...store.state.sheet, type: "settings", tab: id });

    const onKeyDown = (event) => {
        const previous = vertical ? "ArrowUp" : "ArrowLeft";
        const next = vertical ? "ArrowDown" : "ArrowRight";
        let index = TABS.findIndex((each) => each.id === active);

        if (event.key === previous) {
            index = (index + TABS.length - 1) % TABS.length;
        } else if (event.key === next) {
            index = (index + 1) % TABS.length;
        } else if (event.key === "Home") {
            index = 0;
        } else if (event.key === "End") {
            index = TABS.length - 1;
        } else {
            return;
        }

        event.preventDefault();
        select(TABS[index].id);
        event.currentTarget.querySelector(`#settings-tab-${TABS[index].id}`).focus();
    };

    return html`<${Sheet} title="Settings" class="settings-sheet" onClose=${closeSheet}>
        <div class="settings-layout">
            <div
                class="settings-tabs"
                ref=${navigation}
                role="tablist"
                aria-label="Settings categories"
                aria-orientation=${vertical ? "vertical" : "horizontal"}
                onKeyDown=${onKeyDown}
            >
                ${TABS.map(
                    ({ id, label, icon }) => html`<button
                        key=${id}
                        id=${`settings-tab-${id}`}
                        role="tab"
                        aria-selected=${active === id ? "true" : "false"}
                        aria-controls=${`settings-panel-${id}`}
                        tabindex=${active === id ? 0 : -1}
                        onClick=${() => select(id)}
                    >
                        <${Icon} name=${icon} size=${16} /> ${label}
                    </button>`,
                )}
            </div>
            ${TABS.map(
                ({ id, label, body }) => html`<section
                    key=${id}
                    id=${`settings-panel-${id}`}
                    class="settings-panel"
                    role="tabpanel"
                    aria-labelledby=${`settings-tab-${id}`}
                    tabindex="0"
                    hidden=${active !== id}
                >
                    <h3>${label}</h3>
                    ${(active === id || visited.has(id)) && html`<${body} active=${active === id} />`}
                </section>`,
            )}
        </div>
    <//>`;
}
