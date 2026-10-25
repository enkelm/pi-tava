// A draft is a local view. Only its first explicit Send may reserve a native conversation.
import { api, navigate, store, uid } from "./store.js";

const accounts = new Map();
const flights = new Map();
const key = (userId) => `pocket.agentDrafts.${userId}`;
const owner = () => store.state.me?.role === "owner" && store.state.server?.privateAgents >= 4;

function account() {
    if (!owner()) {
        return [];
    }

    const userId = store.state.me.id;

    if (!accounts.has(userId)) {
        let saved = [];

        try {
            const value = JSON.parse(sessionStorage.getItem(key(userId)) ?? "[]");

            if (Array.isArray(value)) {
                saved = value.filter(
                    (draft) =>
                        draft.userId === userId &&
                        typeof draft.id === "string" &&
                        typeof draft.agentId === "string" &&
                        typeof draft.text === "string",
                );
            }
        } catch {
            // Memory still supports drafts and exact retries when sessionStorage is unavailable.
        }

        // Object URLs and interrupted uploads do not survive a page reload; completed native staging does.
        for (const draft of saved) {
            draft.files = (draft.files ?? [])
                .filter((file) => file.state === "done" && file.attachment)
                .map(({ preview, ...file }) => file);
        }

        accounts.set(userId, saved);
    }

    return accounts.get(userId);
}

function save(userId) {
    try {
        sessionStorage.setItem(key(userId), JSON.stringify(accounts.get(userId) ?? []));
    } catch {
        // Never discard an in-memory attempt because storage is unavailable.
    }

    store.set({});
}

export function agentDrafts(agentId) {
    return account().filter((draft) => draft.agentId === agentId && !draft.closed);
}

export function selectedAgentDraft() {
    const selected = store.state.agentDraft;

    return selected
        ? (account().find(
              (draft) =>
                  draft.id === selected.id && draft.agentId === selected.agentId && !draft.closed,
          ) ?? null)
        : null;
}

export function selectAgentDraft(id) {
    const draft = account().find((item) => item.id === id && !item.closed);

    if (draft && store.state.namedAgents.some((agent) => agent.agentId === draft.agentId)) {
        navigate(null, { agentDraft: { id: draft.id, agentId: draft.agentId } });
    }
}

export function openAgentDraft(agentId, { projectId } = {}) {
    if (!owner() || !store.state.namedAgents.some((agent) => agent.agentId === agentId)) {
        return;
    }

    const draft = {
        id: uid(),
        agentId,
        userId: store.state.me.id,
        text: "",
        title: "New chat",
        draft: true,
        ...(projectId === undefined ? {} : { projectId }),
    };

    account().push(draft);
    save(draft.userId);
    selectAgentDraft(draft.id);

    return draft;
}

export function updateAgentDraft(id, text) {
    const draft = account().find((item) => item.id === id);

    if (draft && !draft.requestId && !draft.closed) {
        draft.text = text;
        draft.revision = (draft.revision ?? 0) + 1;
        save(draft.userId);
    }
}

export function updateAgentDraftPastes(id, pastes) {
    const draft = account().find((item) => item.id === id);

    if (draft && !draft.requestId && !draft.closed) {
        draft.pastes = pastes;
        save(draft.userId);
    }
}

export function updateAgentDraftFiles(id, files) {
    const draft = account().find((item) => item.id === id);

    if (draft && !draft.requestId && !draft.closed) {
        draft.files = files;
        save(draft.userId);
    }
}

export function closeAgentDraft(id) {
    const drafts = account();
    const index = drafts.findIndex((item) => item.id === id);
    const draft = drafts[index];

    if (!draft) {
        return;
    }

    for (const file of draft.files ?? []) {
        if (file.preview) {
            URL.revokeObjectURL(file.preview);
            delete file.preview;
        }
    }

    if (draft.requestId) {
        // An attempted send may already be accepted. Keep only its recoverable origin, never cancel or reroute it.
        draft.closed = true;
    } else {
        drafts.splice(index, 1);
    }

    save(draft.userId);
}

function accepted(draft, result, wasSelected) {
    if (
        result.agentId !== draft.agentId ||
        !Number.isSafeInteger(result.id) ||
        result.id < 1 ||
        !result.submissionId
    ) {
        throw new Error(
            "The server returned a different chat identity or no native input receipt.",
        );
    }

    for (const file of draft.files ?? []) {
        if (file.preview) {
            URL.revokeObjectURL(file.preview);
        }
    }

    const drafts = accounts.get(draft.userId) ?? [];
    const index = drafts.indexOf(draft);
    const live = owner() && store.state.me.id === draft.userId;
    const current = live && !draft.closed && selectedAgentDraft() === draft;

    if (index >= 0) {
        drafts.splice(index, 1);
    }

    save(draft.userId);

    if (current && wasSelected) {
        navigate(result.id);
    }

    return result;
}

/** Passive acknowledgement recovery, also used on reload. A 404 is not permission to replay the input. */
export async function recoverAgentDraft(id) {
    const draft = account().find((item) => item.id === id);

    if (!draft?.requestId) {
        return null;
    }

    const wasSelected = selectedAgentDraft() === draft;

    try {
        const result = await api(
            `pip/agents/${encodeURIComponent(draft.agentId)}/submit?requestId=${encodeURIComponent(draft.requestId)}`,
        );

        return accepted(draft, result, wasSelected);
    } catch (error) {
        if (error.status === 404) {
            return null;
        }

        throw error;
    }
}

const projectIntent = (draft, payload) =>
    draft.projectId !== undefined || payload?.projectId !== undefined;

function projectSendCompatibility(draft) {
    const next = "Ask the owner to safely update/restart the backend, then reload this page.";
    const kept = "Your draft, files and chosen project are kept.";

    return draft.requestId
        ? `This server does not advertise project-aware named-agent first Send. ${next} ${kept} Your earlier attempt may already be accepted. Check result only reads its receipt; do not start a replacement Chat.`
        : `This server does not advertise project-aware named-agent first Send. ${next} Nothing was sent. ${kept}`;
}

export function sendAgentDraft(id, composition) {
    const draft = account().find((item) => item.id === id && !item.closed);
    const payload = draft?.payload ??
        composition ?? {
            text: draft?.text ?? "",
            attachments: (draft?.files ?? [])
                .filter((file) => file.state === "done")
                .map((file) => file.attachment),
            inlineFiles: false,
        };

    if (!draft || (!payload.text.trim() && !(payload.attachments?.length > 0))) {
        return Promise.reject(new Error("Nothing to send"));
    }

    if (flights.has(draft)) {
        return flights.get(draft);
    }

    // privateAgents:4 predates explicit first-send project intent. Never omit that intent to
    // make an older backend accept it, nor allocate a request identity for a locally blocked send.
    if (projectIntent(draft, payload) && !(store.state.server?.agentDraftProjects >= 1)) {
        draft.error = projectSendCompatibility(draft);
        save(draft.userId);

        return Promise.reject(new Error(draft.error));
    }

    // A later rejection cannot disprove an earlier lost acknowledgement. Only a fresh
    // attempt's definite HTTP rejection permits editing, as in the saved Chat composer.
    const fresh = !draft.requestId;

    draft.requestId ??= uid();
    // Freeze expanded pastes, files and project intent once; a retry must not rebind an
    // uncertain native request to later draft metadata or a newly supplied composition.
    draft.payload ??= JSON.parse(
        JSON.stringify({
            ...payload,
            ...(draft.projectId === undefined ? {} : { projectId: draft.projectId }),
        }),
    );
    draft.error = "";
    save(draft.userId);
    const wasSelected = selectedAgentDraft() === draft;
    const send = (async () => {
        try {
            const result = await api(`pip/agents/${encodeURIComponent(draft.agentId)}/submit`, {
                ...draft.payload,
                requestId: draft.requestId,
            });

            return accepted(draft, result, wasSelected);
        } catch (error) {
            // A stale hello or mixed backend can still reject the known native request shape.
            // Do not call an unrelated malformed-field error a version mismatch.
            const mismatch =
                error.status === 400 &&
                error.message === "Unknown private agent setting" &&
                draft.payload.projectId !== undefined &&
                Object.keys(draft.payload).every((field) =>
                    ["text", "attachments", "inlineFiles", "projectId"].includes(field),
                );
            const failure = mismatch
                ? Object.assign(
                      new Error(
                          "The backend rejected this project-aware Chat request and may still be running older code. Ask the owner to safely update/restart it, then reload. Your draft, files and chosen project are kept.",
                      ),
                      { status: error.status },
                  )
                : error;

            if (fresh && failure.status >= 400 && failure.status < 500) {
                delete draft.requestId;
                delete draft.payload;
                draft.error = `${failure.message} Your message was not accepted. You can edit it and send again.`;

                if (draft.closed) {
                    const drafts = accounts.get(draft.userId) ?? [];
                    const index = drafts.indexOf(draft);

                    if (index >= 0) {
                        drafts.splice(index, 1);
                    }
                }
            } else {
                draft.error = `${failure.message} Acceptance is uncertain. Your draft is kept. Retry sends the same request; Check result only recovers its acknowledgement.`;
            }

            save(draft.userId);

            throw failure;
        } finally {
            flights.delete(draft);
            save(draft.userId);
        }
    })();

    flights.set(draft, send);

    return send;
}

export const agentDraftSending = (id) =>
    account().some((draft) => draft.id === id && flights.has(draft));
