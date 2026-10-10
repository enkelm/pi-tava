// Your name, access to this server, other devices, and signing out of this device.
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { api, attempt, canSteer, collab, openSheet, scoped, store } from "../store.js";
import { html, Icon } from "../ui.js";
import { PeopleList } from "./people.js";

export function AccountSettings() {
    const { me } = store.state;
    const [name, setName] = useState(me?.name ?? "");
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [problem, setProblem] = useState(null);
    const canInvite = canSteer() && !scoped();
    const owner = me?.role === "owner";

    const save = async (event) => {
        event.preventDefault();
        setBusy(true);
        setSaved(false);
        setProblem(null);

        try {
            await api("me", { name });
            const hello = await api("me");

            store.set({ me: hello.user, users: hello.users });
            setName(hello.user.name);
            setSaved(true);
        } catch (error) {
            setProblem(error.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<${Fragment}>
        <form class="settings-account" onSubmit=${save}>
            <label class="field">
                <span class="label">Your name</span>
                <input
                    name="name"
                    autocomplete="nickname"
                    maxlength="40"
                    required
                    value=${name}
                    onInput=${(event) => {
                        setName(event.currentTarget.value);
                        setSaved(false);
                    }}
                />
            </label>
            <p class="muted small">Shown on your messages to others.</p>
            ${problem && html`<div class="error-box" role="alert">${problem}</div>`}
            ${saved && html`<p class="muted small" role="status">Name saved.</p>`}
            <button
                class="button primary"
                type="submit"
                disabled=${busy || name.trim() === "" || name === me?.name}
            >
                ${busy ? "Saving…" : "Save name"}
            </button>
        </form>
        <div class="group">
            <div class="group-title">Devices and invites</div>
            <div class="settings-actions">
                ${
                    owner &&
                    html`<button
                        class="button"
                        onClick=${() => openSheet({ type: "invite", owner: true })}
                    >
                        <${Icon} name="phone" size=${16} /> Sign in another device
                    </button>`
                }
                ${
                    canInvite &&
                    (collab() || !owner) &&
                    html`<button
                        class="button"
                        onClick=${() => openSheet({ type: "invite" })}
                    >
                        <${Icon} name="plus" size=${16} /> ${collab() ? "Invite someone" : "Sign in another device"}
                    </button>`
                }
            </div>
            <p class="muted small">
                ${owner ? "Your other device can sign in as you. Invites for other people choose their role and access." : canInvite ? "Invite another device or someone you trust. Only the owner can change people’s access." : "Only the owner can change people’s access. Your invitation does not let you invite others."}
            </p>
        </div>
        <${PeopleList} />
        <button
            class="button ghost wide"
            onClick=${() =>
                attempt(async () => {
                    await api("logout", {});
                    location.href = "/";
                })}
        >
            <${Icon} name="logout" size=${16} /> Sign out of this device
        </button>
    <//>`;
}
