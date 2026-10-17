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
    pocket.inputCommand({
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
                const data = await state.read(source.id);

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
    });
}
