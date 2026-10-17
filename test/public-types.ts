// The public types (`types/pocket.d.ts`) and the code agree: compiled by `npm run check`, never run. Each check goes both
// ways: the real type fits the public one, and the public one promises nothing the real one lacks. An error names the
// member that differs. `pocket` has no types in the code: `extension-ui.test.ts` compares its members.
import type {
    CommandContext as RealCommandContext,
    CommandResult as RealCommandResult,
    ExtensionCommand,
    ExtensionModule,
    ExtensionWeb,
    LinkedSession as RealLinkedSession,
    PocketHost,
    SessionServices as RealSessionServices,
    SessionRequestServices as RealSessionRequestServices,
    SessionWebRequest as RealSessionWebRequest,
    WebRequest as RealWebRequest,
} from "../src/server/host.ts";
import type {
    AgentProfile as RealAgentProfile,
    SessionWorkflow as RealSessionWorkflow,
    SessionWorkflowTransition as RealSessionWorkflowTransition,
} from "../src/server/session-workflows.ts";
import type {
    AgentProfile,
    Command,
    CommandContext,
    CommandResult,
    Host,
    LinkedSession,
    Module,
    Pocket,
    SessionServices,
    SessionRequestServices,
    SessionWebRequest,
    SessionWorkflow,
    SessionWorkflowTransition,
    Web,
    WebRequest,
} from "../types/pocket.d.ts";

/**
 * The host's members that only built-in modules use: not public, so not in the types. A new host member goes in the
 * types (with `@since`) or here.
 */
type Internal =
    | "pip"
    | "pipCompaction"
    | "gallery"
    | "watches"
    | "repoWatches"
    | "approvals"
    | "guard"
    | "schedules"
    | "goals"
    | "browsers"
    | "memory";

type PublicHost = Pick<PocketHost, keyof Host>;

export const host = (real: PublicHost): Host => real;
export const hostBack = (types: Host): PublicHost => types;
/** A member of the real host that is neither public nor internal. */
export const hostMembers = (member: Exclude<keyof PocketHost, keyof Host | Internal>): never =>
    member;

export const web = (real: ExtensionWeb): Web => real;
export const webBack = (types: Web): ExtensionWeb => types;
export const webMembers = (member: Exclude<keyof ExtensionWeb, keyof Web>): never => member;

export const context = (real: RealCommandContext): CommandContext => real;
export const contextBack = (types: CommandContext): RealCommandContext => types;
export const contextMembers = (
    member: Exclude<keyof RealCommandContext, keyof CommandContext>,
): never => member;

// Methods compare their parameters both ways, so the shapes they take are checked here on their own.
export const request = (real: RealWebRequest): WebRequest => real;
export const requestBack = (types: WebRequest): RealWebRequest => types;
export const command = (real: ExtensionCommand): Command => real;
export const commandBack = (types: Command): ExtensionCommand => types;
export const result = (real: RealCommandResult): CommandResult => real;
export const resultBack = (types: CommandResult): RealCommandResult => types;
export const linked = (real: RealLinkedSession): LinkedSession => real;
export const linkedBack = (types: LinkedSession): RealLinkedSession => types;
export const sessions = (real: RealSessionServices): SessionServices => real;
export const sessionsBack = (types: SessionServices): RealSessionServices => types;
export const sessionRequest = (real: RealSessionWebRequest): SessionWebRequest => real;
export const sessionRequestBack = (types: SessionWebRequest): RealSessionWebRequest => types;
export const sessionServices = (real: RealSessionRequestServices): SessionRequestServices => real;
export const sessionServicesBack = (types: SessionRequestServices): RealSessionRequestServices =>
    types;
export const profile = (real: RealAgentProfile): AgentProfile => real;
export const profileBack = (types: AgentProfile): RealAgentProfile => types;
export const workflow = (real: RealSessionWorkflow): SessionWorkflow => real;
export const workflowBack = (types: SessionWorkflow): RealSessionWorkflow => types;
export const transition = (real: RealSessionWorkflowTransition): SessionWorkflowTransition => real;
export const transitionBack = (types: SessionWorkflowTransition): RealSessionWorkflowTransition =>
    types;

/** Browser authors use current scoped services and the normal durable input path; hints cannot intercept sends. */
export function browser(pocket: Pocket): void {
    pocket.sessionControl({
        id: "profile",
        slot: "header",
        component: ({ pocket, session }) =>
            pocket.h(pocket.AgentProfileTag, {
                profile: session.conversation?.threadType ?? "chat",
            }),
    });
    pocket.inputCommand({
        id: "choice",
        name: "choice",
        description: "Complete a normal input",
        suggest: async () => [{ name: "choice", completion: "/choice ", completeOnEnter: true }],
    });
    pocket.sheet<{ id: number; opening: string }>({
        id: "choice",
        title: "Choice",
        component: ({ isOpen, close }) => {
            if (isOpen()) {
                close();
            }

            return null;
        },
    });
    const stop = pocket.onSessionChange((session) => {
        if (session.id !== null) {
            void pocket.sessionApi(session.id, "status");
        }
    });
    const session = pocket.session();

    if (session.id !== null) {
        void pocket.submit(session.id, {
            text: "Human input",
            requestId: pocket.requestId(),
            mode: "followUp",
        });
        pocket.navigate(session.id);
    }

    stop();
}

/** A module written against the public types is one the loader takes. */
export const module = (types: Module): ExtensionModule => types;
