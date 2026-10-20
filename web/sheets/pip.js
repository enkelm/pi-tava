// PiP is app-owned. Private chats and shared-discussion replies have independent model choices.
import { useEffect, useState } from "preact/hooks";
import { api, openSheet, store } from "../store.js";
import { html, Icon, Loader, Switch } from "../ui.js";
import { defaultLabel, ModelPicker } from "./model.js";

const COMPACT_CHOICES = [
    [40000, "Above 40k tokens"],
    [60000, "Above 60k tokens"],
    [100000, "Above 100k tokens"],
    [0, "As sessions do"],
];

export function PipSettings({ active = true }) {
    const owner = store.state.me?.role === "owner";
    const supported = store.state.server?.pipSettings >= 1;
    const [data, setData] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        if (!active || !owner || !supported) {
            return;
        }

        let live = true;

        setProblem(null);
        api("pip/settings").then(
            (result) => live && setData(result),
            (error) => live && setProblem(error.message),
        );

        return () => {
            live = false;
        };
    }, [active, owner, supported, reload]);

    const save = async (path, change) => {
        if (busy) {
            return;
        }

        setBusy(true);
        setProblem(null);

        try {
            const result = await api(path, change);

            setData(result);
        } catch (error) {
            setProblem(`${error.message} Reload these settings to check what was saved.`);

            throw error;
        } finally {
            setBusy(false);
        }
    };

    const change = (path, value) => save(path, value).catch(() => {});

    if (!owner) {
        return html`<p class="muted small">Only the owner can manage PiP settings.</p>`;
    }

    if (!supported) {
        return html`<p class="muted small">
            Restart the server (menu → Restart server) to manage PiP here.
        </p>`;
    }

    const choices = [
        ["chats", "PiP chats", "Private conversations with your assistant."],
        [
            "collaborator",
            "Collaborator",
            "Answers to explicit @PiP mentions in shared chat and review discussions, separate from private PiP chats.",
        ],
    ];

    return html`<div>
        ${problem && html`<div class="error-box" role="alert">${problem}</div>`}
        ${!data && !problem && html`<${Loader} label="Loading PiP settings" />`}
        ${
            data &&
            html`
            <div class="setting">
                <div class="grow">
                    <div class="small">PiP execution</div>
                    <div class="muted small">
                        ${data.enabled ? "Enabled." : "Paused."} Pausing stops private runs, shared mention answers and compaction, and blocks new Reviewer diff comments. Follow reports and scheduled messages wait; history is kept.
                    </div>
                </div>
                <${Switch}
                    on=${data.enabled}
                    disabled=${busy}
                    label=${`PiP execution: ${data.enabled ? "enabled" : "paused"}`}
                    onChange=${() => change("pip/settings", { enabled: !data.enabled })}
                />
            </div>
            <p class="muted small">These model choices are independent. Changing one never changes the other.</p>
            ${choices.map(([target, label, description]) => {
                const agent = data[target];
                const chosen = agent.model && {
                    ...agent.model,
                    thinkingLevel: agent.thinkingLevel,
                };
                const locked =
                    busy ||
                    (target === "chats" && (agent.busy || (!data.enabled && agent.id === null)));

                return html`<div class="setting wrap" key=${target}>
                    <div class="grow">
                        <div class="small">${label}</div>
                        <div class="muted small">${description}</div>
                        ${target === "chats" && agent.busy && html`<div class="muted small">Change this model when PiP is idle.</div>`}
                    </div>
                    <button
                        class="button pip-settings-model"
                        disabled=${locked}
                        aria-label=${`Choose ${label} model`}
                        onClick=${() => openSheet({ type: "pip-model", target, agent })}
                    >
                        <span>${chosen ? defaultLabel(chosen, store.state.models) : "Choose a model"}</span>
                        <${Icon} name="chevron" size=${14} />
                    </button>
                </div>`;
            })}
            <div class="setting wrap">
                <div class="grow">
                    <div class="small">Compact PiP chats</div>
                    <div class="muted small">Once idle above this, older private messages become a short summary.</div>
                </div>
                <div class="segmented" role="group" aria-label="Compact PiP chats">
                    ${COMPACT_CHOICES.map(
                        ([value, label]) => html`<button
                        key=${value}
                        class=${data.compactAt === value ? "on" : ""}
                        aria-pressed=${data.compactAt === value}
                        disabled=${busy}
                        onClick=${() => change("pip/settings", { compactAt: value })}
                    >
                        ${label}
                    </button>`,
                    )}
                </div>
            </div>
        `
        }
        <button class="link small" disabled=${busy} onClick=${() => setReload((value) => value + 1)}>
            Reload PiP settings
        </button>
    </div>`;
}

/** A normal sheet-stack entry, so the picker cannot close or drag the settings dialog underneath it. */
export function PipModelPicker({ target, agent: initialAgent }) {
    const [agent, setAgent] = useState(initialAgent);
    const [busy, setBusy] = useState(false);
    const [opening] = useState(store.state.sheet);
    const isOpen = () => store.state.sheet === opening;
    const close = () => isOpen() && openSheet({ type: "settings", tab: "pip" });

    const configure = async (change) => {
        if (!isOpen() || busy || store.state.me?.role !== "owner") {
            return;
        }

        setBusy(true);

        try {
            const result = await api(`pip/settings/${target}`, {
                ...change,
                ...(target === "collaborator" ? { expectedRevision: agent.revision } : {}),
            });

            if (isOpen()) {
                setAgent(result[target]);
            }
        } finally {
            setBusy(false);
        }
    };

    return html`<${ModelPicker}
        title=${target === "chats" ? "PiP chats model" : "Collaborator model"}
        agent=${agent}
        disabled=${busy || (target === "chats" && agent.busy)}
        onConfigure=${configure}
        onClose=${close}
    />`;
}
