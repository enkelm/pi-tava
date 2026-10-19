import { isHandoffRouting, suggestHandoffs } from "./commands.js";
import { createControls } from "./controls.js";
import { createHandoffSheet } from "./sheet.js";
import { createHandoffState } from "./state.js";

export const pocketApi = 1;

export default function setup(pocket) {
    const state = createHandoffState(pocket);
    const { HandoffButton, WorkflowTools } = createControls(pocket, state);

    pocket.onDispose(state.dispose);
    pocket.style("style.css");
    pocket.sessionControl({ id: "handoff", slot: "header", component: HandoffButton });
    pocket.sessionControl({ id: "workflow", slot: "composer", component: WorkflowTools });
    pocket.sheet({
        id: "handoff",
        title: "Choose next thread",
        component: createHandoffSheet(pocket, state),
    });
    const commandSpec = {
        id: "handoff",
        name: "handoff",
        description: "Choose the next thread and add instructions",
        suggest: async (text, caret = text.length) => {
            const source = pocket.session();

            if (
                !source.me ||
                !source.canSteer ||
                source.id === null ||
                source.conversation?.kind !== "session" ||
                !isHandoffRouting(text, caret)
            ) {
                return [];
            }

            const current = () => {
                const value = pocket.session();

                return (
                    state.isCurrent(source.me.id, source.id) &&
                    value.me?.role === source.me.role &&
                    value.canSteer &&
                    value.conversation?.kind === "session"
                );
            };

            try {
                // Routing is explicit demand: a checkout or driver can change without a
                // public session revision. Never offer roles from a settled context cache.
                const data = await state.refresh(source.id);

                if (!data || !current()) {
                    return [];
                }

                const { profiles } = pocket.session();
                const options = (data.options ?? []).map((option) => ({
                    ...option,
                    description:
                        profiles.find((profile) => profile.id === option.targetType)?.description ??
                        option.targetType,
                }));

                return suggestHandoffs(text, options, caret);
            } catch (failure) {
                return current()
                    ? [
                          {
                              name: "handoff",
                              description: `Could not load roles: ${failure.message}. Try again.`,
                              disabled: true,
                          },
                      ]
                    : [];
            }
        },
    };
    const command = pocket.inputCommand(commandSpec);

    // The composer retains rendered hints until its contribution changes. Replace only on a
    // semantic invalidation, never on request completion (which would create a refresh loop).
    state.onInvalidate(() => command.update({ suggest: (...args) => commandSpec.suggest(...args) }));
}
