// The host supplies the outer sheet and durable submission; this form owns only its editable draft.
import { profileName } from "./state.js";

const keyOf = (option) => `${option.targetType}:${option.relationship}`;
const DIRECTION_PREFIX = "Instructions:\n";
const GROUPS = [
    { relationship: "same-work", label: "Same Work Item" },
    { relationship: "new-work", label: "New Work Item" },
];

function readDraft(key, pocket) {
    try {
        const saved = JSON.parse(sessionStorage.getItem(key));

        if (
            typeof saved?.choice === "string" &&
            typeof saved.instructions === "string" &&
            typeof saved.revision === "string"
        ) {
            return saved;
        }
    } catch {
        // An unavailable per-tab store must not prevent a handoff request.
    }

    return { choice: "", instructions: "", revision: pocket.requestId() };
}

export function createHandoffSheet(pocket, state) {
    const { html, h, useEffect, useLayoutEffect, useRef, useState, Loader, AgentProfileTag } =
        pocket;

    function Picker({
        id,
        opening,
        userId,
        session,
        scope,
        activity,
        revision,
        status,
        close,
        isOpen,
    }) {
        const draftKey = `pocket.handoffDraft.${userId}.${id}`;
        const [draft, setDraft] = useState(() => readDraft(draftKey, pocket));
        const [direction, setDirection] = useState(false);
        const data = status.error ? null : status.data;
        const [loading, setLoading] = useState(true);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const [retry, setRetry] = useState(0);
        const waiting = loading || (!data && status.loading);
        const visibleError = status.error || error;
        const mounted = useRef(false);
        const submitting = useRef(false);
        const field = useRef(null);
        const next = useRef(null);
        const readKey = useRef(null);

        useLayoutEffect(() => {
            mounted.current = true;

            return () => {
                mounted.current = false;
            };
        }, []);

        useEffect(() => state.watchPicker(id), [id]);

        useEffect(() => {
            let stopped = false;
            const key = JSON.stringify([id, opening, userId, retry]);
            const fresh = readKey.current !== key;

            readKey.current = key;
            setLoading(true);
            setError("");

            if (!activity.paused) {
                // Open/Refresh asks for fresh options. Return joins the service's resumed read,
                // including a fast response cached before this passive effect gets to run.
                const request = fresh ? state.refresh(id) : state.read(id);

                request.then(
                    (value) => {
                        if (value !== null && !stopped && state.isCurrent(userId, id)) {
                            setLoading(false);
                        }
                    },
                    () => {
                        if (!stopped && state.isCurrent(userId, id)) {
                            // The shared status owns read errors, including routine polls and
                            // their recovery. Local errors belong to submission only.
                            setLoading(false);
                        }
                    },
                );
            }

            return () => {
                stopped = true;
            };
        }, [id, opening, userId, retry, scope, activity, revision]);

        useEffect(() => {
            if (direction) {
                field.current?.focus();
            } else if (!loading) {
                next.current?.focus();
            }
        }, [direction, loading]);

        const source = session.sessions.find((each) => each.id === id);
        const options = data?.options ?? [];
        const selected = options.find((each) => keyOf(each) === draft.choice);
        const paused = source?.workflow?.paused || data?.workflow?.paused;
        const readOnly = source?.workflow?.readOnly || data?.workflow?.readOnly || paused;
        const blockingReasons = new Map();

        for (const option of options) {
            if ((!option.enabled || readOnly) && option.reason) {
                blockingReasons.set(option.reason, (blockingReasons.get(option.reason) ?? 0) + 1);
            }
        }

        const sharedReasons = [...blockingReasons]
            .filter(([, count]) => count > 1)
            .map(([reason]) => reason);
        const reasonId = (index) => `handoff-blocking-reason-${opening}-${index}`;
        const valid =
            session.canSteer &&
            selected?.enabled &&
            !readOnly &&
            source?.workflow?.profileAvailable !== false &&
            data?.workflow?.profileAvailable !== false &&
            !(
                selected?.relationship === "new-work" &&
                draft.worktree === true &&
                session.me?.role !== "owner"
            ) &&
            !loading;

        const update = (change) => {
            const value = { ...draft, ...change, revision: pocket.requestId() };

            setDraft(value);

            try {
                sessionStorage.setItem(draftKey, JSON.stringify(value));
            } catch {
                // Keep the open form usable when browser storage is unavailable.
            }
        };

        const save = async (event) => {
            event.preventDefault();

            if (
                submitting.current ||
                !valid ||
                !state.isCurrent(userId, id) ||
                !pocket.session().canSteer
            ) {
                return;
            }

            if (!direction) {
                setDirection(true);

                return;
            }

            const saved = JSON.stringify(draft);
            const flag = selected.relationship === "new-work" ? "--new" : "--same";
            // The label makes arbitrary instructions, including leading --flags, literal prose.
            const instructions = draft.instructions
                ? `\n${DIRECTION_PREFIX}${draft.instructions}`
                : "";
            const ownWorktree = selected.relationship === "new-work" && draft.worktree === true;
            const text = `/handoff ${selected.targetType} ${flag}${ownWorktree ? " --worktree" : ""}${instructions}`;

            submitting.current = true;
            setBusy(true);
            setError("");

            try {
                // Resolve on durable input acceptance, never on summary or successor creation.
                // An unchanged reopened draft keeps the request identity after a late acceptance.
                await pocket.submit(id, { text, requestId: draft.revision, mode: "followUp" });

                try {
                    if (sessionStorage.getItem(draftKey) === saved) {
                        sessionStorage.removeItem(draftKey);
                    }
                } catch {
                    // Storage failure cannot undo durable acceptance.
                }

                if (state.isCurrent(userId, id)) {
                    // The host's close callback is guarded by this logical sheet opening.
                    close();
                }
            } catch (failure) {
                if (pocket.session().me?.id !== userId) {
                    return;
                }

                if (mounted.current && isOpen() && state.isCurrent(userId, id)) {
                    setError(
                        `${failure.message} Your selection and instructions are kept for retry.`,
                    );
                } else {
                    pocket.notify(
                        "error",
                        `${failure.message} Reopen Handoff to retry your saved request.`,
                    );
                }
            } finally {
                submitting.current = false;

                if (mounted.current) {
                    setBusy(false);
                }
            }
        };

        // Escape, scrim, drag and browser Back stay available even during a slow submit.
        return html`<div class="handoff-picker">
            ${waiting && html`<${Loader} label="Loading handoff options" />`}
            ${
                !waiting &&
                !data &&
                html`
                    <p class="handoff-error" role="alert">${visibleError}</p>
                    <button class="button" onClick=${() => setRetry((each) => each + 1)}>
                        Retry
                    </button>
                `
            }
            ${
                !waiting &&
                data &&
                html`<form class="handoff-form" onSubmit=${save}>
                    ${paused && html`<p class="handoff-warning small" role="status">Work Item execution is paused. Ask the owner to resume it.</p>`}
                    ${
                        !direction
                            ? html`
                                  <p class="muted small">
                                      Choose the next role, then add any instructions before
                                      sending.
                                  </p>
                                  ${
                                      sharedReasons.length > 0 &&
                                      html`<div class="handoff-warning small" role="status">
                                          ${sharedReasons.map((reason, index) => html`<p id=${reasonId(index)}>${reason}</p>`)}
                                      </div>`
                                  }
                                  ${GROUPS.map((group) => {
                                      const choices = options.filter(
                                          (each) => each.relationship === group.relationship,
                                      );

                                      if (choices.length === 0) {
                                          return null;
                                      }

                                      return html`<fieldset aria-label=${group.label}>
                                          <legend class="handoff-label">${group.label}</legend>
                                          ${
                                              group.relationship === "new-work" &&
                                              html`
                                                  <p class="muted small">
                                                      Start separate work linked to this Work Item.
                                                  </p>
                                              `
                                          }
                                          <div class="handoff-options">
                                              ${choices.map((each) => {
                                                  const disabled = !each.enabled || readOnly;
                                                  const sharedIndex = disabled
                                                      ? sharedReasons.indexOf(each.reason)
                                                      : -1;

                                                  return html`<label
                                                      class=${`handoff-option ${disabled ? "disabled" : ""}`}
                                                  >
                                                      <input
                                                          type="radio"
                                                          name="handoff-option"
                                                          value=${keyOf(each)}
                                                          checked=${draft.choice === keyOf(each)}
                                                          disabled=${disabled}
                                                          aria-describedby=${sharedIndex >= 0 ? reasonId(sharedIndex) : undefined}
                                                          onChange=${() => update({ choice: keyOf(each), worktree: false })}
                                                      />
                                                      <span class="handoff-option-profile">
                                                          <${AgentProfileTag}
                                                              profile=${each.targetType}
                                                              iconOnly=${true}
                                                          />
                                                      </span>
                                                      <span class="handoff-option-copy">
                                                          <strong
                                                              >${`Start ${profileName(session.profiles, each.targetType)}`}</strong
                                                          >
                                                          ${each.reason && sharedIndex < 0 && html`<span class="small muted">${each.reason}</span>`}
                                                      </span>
                                                  </label>`;
                                              })}
                                          </div>
                                      </fieldset>`;
                                  })}
                                  ${
                                      options.length === 0 &&
                                      html`
                                          <p class="muted small">
                                              No handoff options are available. Open the active
                                              thread to continue.
                                          </p>
                                      `
                                  }
                              `
                            : html`
                                  <div class="handoff-destination">
                                      ${selected && html`<${AgentProfileTag} profile=${selected.targetType} />`}
                                      <span class="small muted"
                                          >${selected?.relationship === "new-work" ? "New Work Item" : "Same Work Item"}</span
                                      >
                                  </div>
                                  ${
                                      (session.me?.role === "owner" || draft.worktree === true) &&
                                      selected?.relationship === "new-work" &&
                                      html`<label class="handoff-option">
                                          <input
                                              type="checkbox"
                                              checked=${draft.worktree === true}
                                              disabled=${busy || session.me?.role !== "owner"}
                                              onChange=${(event) => update({ worktree: event.currentTarget.checked })}
                                          />
                                          <span class="handoff-option-copy">
                                              <strong>Own Git worktree</strong>
                                              <span class="small muted"
                                                  >${
                                                      session.me?.role === "owner"
                                                          ? "Copy tracked changes and bounded new files; ignored files stay behind. The source thread still becomes read-only."
                                                          : "Only the owner can choose an own worktree. Go Back and reselect a role to inherit the checkout instead."
                                                  }</span
                                              >
                                          </span>
                                      </label>`
                                  }
                                  <div class="handoff-field">
                                      <label class="handoff-label" for="handoff-direction"
                                          >What should the next agent focus on? (optional)</label
                                      >
                                      <textarea
                                          id="handoff-direction"
                                          ref=${field}
                                          rows="5"
                                          value=${draft.instructions}
                                          disabled=${busy}
                                          aria-describedby="handoff-send-hint"
                                          onInput=${(event) => update({ instructions: event.currentTarget.value })}
                                      ></textarea>
                                  </div>
                                  <p id="handoff-send-hint" class="muted small" role="status">
                                      ${
                                          busy
                                              ? "Sending request… You can close this popup; sending continues."
                                              : "The popup closes when your request is accepted. You can keep browsing while the agent prepares the handoff."
                                      }
                                  </p>
                              `
                    }
                    ${visibleError && html`<p class="handoff-error" role="alert">${visibleError}</p>`}
                    <div class="handoff-form-actions">
                        <button
                            class="button"
                            type="button"
                            disabled=${busy}
                            onClick=${() => (direction ? setDirection(false) : setRetry((each) => each + 1))}
                        >
                            ${direction ? "Back" : "Refresh options"}
                        </button>
                        <button class="button" type="button" onClick=${close}>
                            ${busy ? "Close" : "Cancel"}
                        </button>
                        <button
                            ref=${next}
                            class="button primary"
                            type="submit"
                            disabled=${busy || !valid}
                        >
                            ${busy ? "Sending…" : direction ? "Start thread" : "Next"}
                        </button>
                    </div>
                </form>`
            }
        </div>`;
    }

    function HandoffSheet({ close, isOpen, id, opening }) {
        const { session, scope, activity, revision, status } = state.useContext();

        if (!session.me || !session.canSteer || session.id !== id) {
            return null;
        }

        return h(Picker, {
            key: JSON.stringify([session.me.id, id, opening]),
            id,
            opening,
            userId: session.me.id,
            session,
            scope,
            activity,
            revision,
            status,
            close,
            isOpen,
        });
    }

    return HandoffSheet;
}
