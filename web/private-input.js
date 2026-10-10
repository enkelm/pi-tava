// Private Pi input helpers. Commands go to Herdr, never Durable's command parser or history.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { api, store, uid } from "./store.js";
import { formatBytes, html, Icon, Spinner } from "./ui.js";
import { ModelPicker } from "./sheets/model.js";

const commands = [
    { name: "model", args: "provider/model", description: "Switch this Pi's model" },
    { name: "thinking", args: "level", description: "Set thinking level" },
    { name: "compact", args: "[instructions]", description: "Compact the current context" },
    { name: "name", args: "title", description: "Rename this Pi session" },
    { name: "session", description: "Show session info in the terminal" },
    { name: "reload", description: "Reload Pi's extensions, skills and templates" },
    { name: "new", description: "Start a fresh Pi session" },
    { name: "skill:", args: "name [request]", description: "Run a skill installed in this Pi" },
];

export function privateCommands(text) {
    const match = /^\/([^\s]*)$/.exec(text);

    return match ? commands.filter((command) => command.name.startsWith(match[1])) : [];
}

export function PrivateModelPicker(props) {
    useBack(true, props.onClose);

    return html`<${ModelPicker} ...${props} privateMode=${true} />`;
}

/** Upload tokens and previews live only in this pane's memory. Files are never sent automatically. */
export function usePrivateAttachments(id) {
    const [files, setFiles] = useState([]);
    const items = useRef(new Map());
    const epoch = useRef(0);
    const owner = () => (store.state.me?.role === "owner" ? store.state.me.id : null);

    const discard = (item) => {
        item.controller.abort();

        if (item.preview) {
            URL.revokeObjectURL(item.preview);
        }

        if (item.id && !item.retained) {
            api(
                `private/${encodeURIComponent(id)}/upload?id=${encodeURIComponent(item.id)}`,
                undefined,
                {
                    method: "DELETE",
                },
            ).catch(() => {});
        }
    };

    const publish = () => setFiles([...items.current.values()]);

    useLayoutEffect(() => {
        epoch.current++;
        setFiles([]);

        return () => {
            epoch.current++;

            for (const item of items.current.values()) {
                discard(item);
            }

            items.current.clear();
        };
    }, [id]);

    const add = (selected, revision, onError) => {
        const who = owner();
        const turn = epoch.current;

        for (const file of selected) {
            if (items.current.size >= 10) {
                onError("Attach up to 10 files per message.");
                break;
            }

            if (file.size > 50 * 1024 * 1024) {
                onError(`${file.name} is too large. Files can be up to 50 MiB.`);
                continue;
            }

            const item = {
                key: uid(),
                name: file.name,
                size: file.size,
                state: "uploading",
                preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
                controller: new AbortController(),
            };

            items.current.set(item.key, item);
            publish();
            const timeout = setTimeout(() => item.controller.abort(), 60000);

            api(
                `private/${encodeURIComponent(id)}/upload?revision=${encodeURIComponent(revision)}&name=${encodeURIComponent(file.name)}`,
                file,
                { signal: item.controller.signal },
            )
                .then(
                    (result) => {
                        item.id = result.id;

                        if (
                            turn !== epoch.current ||
                            who !== owner() ||
                            !items.current.has(item.key)
                        ) {
                            discard(item);

                            return;
                        }

                        item.state = "done";
                        publish();
                    },
                    (error) => {
                        if (
                            turn !== epoch.current ||
                            who !== owner() ||
                            !items.current.has(item.key)
                        ) {
                            return;
                        }

                        item.state = "error";
                        publish();
                        onError(
                            `${file.name}: ${error.name === "AbortError" ? "Upload stopped. Remove the file and attach it again." : error.message}`,
                        );
                    },
                )
                .finally(() => clearTimeout(timeout));
        }
    };

    const remove = (item) => {
        items.current.delete(item.key);
        discard(item);
        publish();
    };

    // Protect pending/uncertain delivery. A known-unsent refusal can lift this client-side
    // protection; DELETE still cannot remove files the server has already admitted or retained.
    const retain = (retained = true) => {
        for (const item of items.current.values()) {
            item.retained = retained;
        }
    };

    const clear = () => {
        for (const item of items.current.values()) {
            discard(item);
        }

        items.current.clear();
        publish();
    };

    return { files, add, remove, retain, clear };
}

export function PrivateAttachmentChips({ files, disabled, onRemove }) {
    return (
        files.length > 0 &&
        html`<div class="files private-attachments">
        ${files.map(
            (file) => html`<span
            key=${file.key}
            class=${`chip ${file.preview ? "with-thumb" : ""} ${file.state === "error" ? "warn" : ""}`}
        >
            ${file.preview && html`<img class="chip-thumb" src=${file.preview} alt="" />`}
            ${
                file.state === "uploading"
                    ? html`<${Spinner} />`
                    : !file.preview && html`<${Icon} name="clip" size=${14} />`
            }
            <span class="private-attachment-name" title=${file.name}>${file.name}</span>
            <span class="muted">${file.state === "error" ? "Failed" : formatBytes(file.size)}</span>
            <button
                type="button"
                class="icon-button small"
                disabled=${disabled}
                aria-label=${`Remove ${file.name}`}
                onClick=${() => onRemove(file)}
            >
                <${Icon} name="close" size=${12} />
            </button>
        </span>`,
        )}
    </div>`
    );
}
