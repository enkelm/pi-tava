/**
 * What pi-tava writes into stored conversations: the kinds of its own entries, and the markers it puts into message
 * text. Stored entries and the web app depend on these exact values: never change them.
 */

/** How a file sent along with a message starts (`<file name="path">`): such parts show as the file's name only. */
export const FILE_BLOCK = '<file name="';
/** The entry kind of a note about what a person did (`Commands.note`). */
export const NOTE_ENTRY = "pocket.note";
/** An immutable question in a Work Item's private PiP chat, written with its decision record. */
export const PIP_QUESTION_ENTRY = "pocket.pip-question";

/** Server-only provenance persisted on the first native TextContent part, never inferred from prose. */
export type WorkItemEvent = {
    kind: "workItem";
    source: number;
    state: "running" | "idle";
    fingerprint: string;
};

/** Display-only report provenance, read from native assistant entry data rather than report prose. */
export type PassiveReport = {
    report: "workItem" | "thread" | "helper";
    state: "reported" | "held" | "question";
    summary: string;
    source?: number;
    sourceEntryId?: number;
    controllerId?: number;
    originChatId?: number;
    questionId?: string;
};

/** A correlated service answer remains visible, separate from passive application observations. */
export type AgentAnswer = {
    questionId: string;
    agentId: string;
    name: string;
    chatId: number;
};

const positiveId = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const boundedText = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * Called only after native assistant authorship/signature checks. Missing additive metadata is historical;
 * present-but-malformed metadata must never fall back to a trusted historical fold.
 */
export function readPassiveReport(value: unknown, text: string): PassiveReport | undefined {
    if (value === null || typeof value !== "object") {
        return undefined;
    }

    const data = value as Record<string, unknown>;
    const helper = data.privateHelperReport;
    const legacyHelper = positiveId(helper) && typeof data.held === "boolean";
    const known =
        typeof data.reason === "string" &&
        [
            "agent-work-report",
            "agent-report-held",
            "agent-contact-report",
            "agent-contact-report-held",
            "agent-helper-report",
        ].includes(data.reason);

    if (
        data.appAuthored !== true ||
        (!known && !(data.reason === undefined && legacyHelper)) ||
        (helper !== undefined && !positiveId(helper)) ||
        (data.held !== undefined && typeof data.held !== "boolean") ||
        (data.target !== undefined && !positiveId(data.target)) ||
        (data.sourceEntryId !== undefined && !positiveId(data.sourceEntryId)) ||
        (data.controllerId !== undefined && !positiveId(data.controllerId)) ||
        (data.originChatId !== undefined && !positiveId(data.originChatId))
    ) {
        return undefined;
    }

    const report =
        data.reason === "agent-helper-report" || positiveId(helper)
            ? "helper"
            : data.reason === "agent-work-report" || data.reason === "agent-report-held"
              ? "workItem"
              : "thread";
    const held =
        data.reason === "agent-report-held" ||
        data.reason === "agent-contact-report-held" ||
        (report === "helper" && data.held === true);
    const modern = ["eventId", "source", "state", "summary", "questionId"].some(
        (key) => data[key] !== undefined,
    );

    if (modern) {
        if (
            !boundedText(data.eventId, 256) ||
            !positiveId(data.source) ||
            (data.state !== "reported" && data.state !== "held" && data.state !== "question") ||
            !boundedText(data.summary, 200) ||
            /[\r\n\u0000-\u001f\u007f]/.test(data.summary) ||
            (data.controllerId !== undefined && !positiveId(data.controllerId)) ||
            (data.originChatId !== undefined && !positiveId(data.originChatId)) ||
            (data.questionId !== undefined &&
                (data.state !== "question" || !boundedText(data.questionId, 256))) ||
            (held && data.state !== "held") ||
            (!held && report !== "helper" && data.state === "held")
        ) {
            return undefined;
        }

        return {
            report,
            state: data.state as PassiveReport["state"],
            summary: data.summary,
            source: data.source,
            ...(data.sourceEntryId === undefined ? {} : { sourceEntryId: data.sourceEntryId }),
            ...(data.controllerId === undefined ? {} : { controllerId: data.controllerId }),
            ...(data.originChatId === undefined ? {} : { originChatId: data.originChatId }),
            ...(data.questionId === undefined ? {} : { questionId: data.questionId }),
        } as PassiveReport;
    }

    if (data.sourceEntryId !== undefined && data.target === undefined) {
        return undefined;
    }

    // Only widen visibility after trust is established. Legacy prose can prevent a fold, never create one
    // or nominate a source. Old Work Item reports did not persist the question state separately.
    const question = !held && /^Human decision needed:/m.test(text);

    return {
        report,
        state: held ? "held" : question ? "question" : "reported",
        summary: held ? "Report held" : question ? "Human decision needed" : "Report observed",
        ...(data.target === undefined ? {} : { source: data.target }),
        ...(data.sourceEntryId === undefined ? {} : { sourceEntryId: data.sourceEntryId }),
        ...(data.controllerId === undefined ? {} : { controllerId: data.controllerId }),
        ...(data.originChatId === undefined ? {} : { originChatId: data.originChatId }),
    } as PassiveReport;
}

/** Conservative readers of additive native content metadata; imported entries must reject it separately. */
export function isWorkItemEvent(value: unknown): value is WorkItemEvent {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const event = value as Record<string, unknown>;

    return (
        event.kind === "workItem" &&
        positiveId(event.source) &&
        (event.state === "running" || event.state === "idle") &&
        boundedText(event.fingerprint, 256)
    );
}

export function isAgentAnswer(value: unknown): value is AgentAnswer {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const actor = value as Record<string, unknown>;

    return (
        positiveId(actor.chatId) &&
        boundedText(actor.questionId, 256) &&
        boundedText(actor.agentId, 256) &&
        boundedText(actor.name, 200)
    );
}

/** Imported context notes have no asserted human author. Metadata is not a visible transcript card. */
export const IMPORT_NOTE_ENTRY = "pocket.import-note";
export const IMPORT_META_ENTRY = "pocket.import-meta";

/** The speaker prefix pi-tava adds to messages when several people share the server. */
export const FROM_PREFIX = /^\[from: ([^\]\n]{1,60})\] /;

/** What separates a message from the list of files attached to it. The web app splits messages on it too. */
export const ATTACHMENTS_HEADING = "\n\nAttached files (saved on the server):\n";

/**
 * A message shown to people (its speaker taken off) in two: what they wrote, and the list of attached files if any. One
 * of files alone sent before 0.14.0 has the heading without the blank line before it.
 */
export function splitAttachments(text: string): [written: string, files: string | undefined] {
    const whole = text.startsWith(ATTACHMENTS_HEADING.trimStart()) ? `\n\n${text}` : text;
    const [written = "", files] = whole.split(ATTACHMENTS_HEADING);

    return [written, files];
}

/** The entry kind of a command someone ran. */
export const SHELL_ENTRY = "pocket.shell";

/**
 * The entry kind that ends a session continued from Pi in the terminal: what comes before it is Pi's. It gives the model
 * nothing; it carries the context edits Pi had made to that history.
 */
export const FROM_PI_ENTRY = "pocket.from-pi";

/** What that entry holds: the Pi session's id, its title, and its file. */
export type FromPiData = { session: string; title: string; file: string };
/** The entry kind of an extension command's card: text for the people here, never in Pi's context. */
export const COMMAND_ENTRY = "pocket.extension-command";

export type CommandData = {
    command: string;
    by: string;
    name: string;
    output: string;
    taskId: number;
    /** Only the end of a longer output is kept. */
    clipped?: boolean;
};

/** What a command's entry holds. */
export type ShellData = {
    command: string;
    by: string;
    name: string;
    /** Pi sees this command and its output. */
    context: boolean;
    output: string;
    /** Absent when the command did not get to exit. */
    code?: number;
    status: "done" | "timeout" | "failed" | "interrupted" | "stopped";
    /** The output was longer: this is its end. */
    clipped?: boolean;
    taskId: number;
};
