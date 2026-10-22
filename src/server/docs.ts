/**
 * Pi Pocket's own durable documents. They live next to the transcripts in the same storage and change in the same
 * commits, so a crash never leaves them disagreeing with the conversation.
 *
 * Kinds are part of the stored data: rename one and old sessions lose it.
 */
import type { JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
    type ConversationId,
    defineDoc,
    defineDocFamily,
    type EntryId,
    type TaskId,
} from "@earendil-works/pi-durable";
import { currentStateCheckpoints } from "./doc-checkpoint.ts";
import type { Repeat } from "./when.ts";
import type { ActivePi } from "./pi-sessions/herdr.ts";
import type { Worktree } from "./worktrees.ts";
import type { Changes } from "./changes.ts";
import type { ThreadType } from "./workflow-docs.ts";
import type { WorkspaceLocation } from "./workspace-location.ts";
import type { DiagnosticJournal } from "./diagnostics/recorder.ts";

/** Private, bounded diagnostic observations; never a room document or inherited fork history. */
export const DiagnosticsDoc = defineDoc<DiagnosticJournal>({
    kind: "pocket.diagnostics",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ records: [], evicted: 0, since: Date.now() }),
});

export {
    PrivateAgentDoc,
    PrivateAgentCreatesDoc,
    PrivateAgentCallsDoc,
} from "./private-agent-docs.ts";
export { AgentIdentitiesDoc } from "./agent-identity-docs.ts";
export { MemoryReceiptsDoc } from "./private-memory-docs.ts";

export type SessionMeta = {
    title?: string;
    cwd: string;
    /** Creation-time destination; project moves/default edits never change it. */
    location?: WorkspaceLocation;
    createdAt: number;
    updatedAt: number;
    createdBy?: string;
    archived?: boolean;
    projectId?: string;
    /** Ordinary untyped legacy entries become Worker; linked roots and new unassigned threads are Chats. */
    threadType?: ThreadType;
    /** Handoff visibility flows from this immediate source; older flattened-origin references also remain valid. */
    accessFrom?: number;
    workItemId?: string;
    /** The initial import slice is restricted to the owner, including forks and subagents. */
    ownerOnly?: boolean;
    imported?: boolean;
    /** The session this one was forked from, and the last entry it inherited; no entry: forked before the first message. */
    forkedFrom?: { id: number; entryId?: number };
    /** The session that started this one (`linked-sessions.ts`): a link only, which gives no access and owns nothing. */
    linkedFrom?: { id: number };
    /** The most Pi may spend here, in dollars, subagents included. */
    budget?: number;
    /** The git worktree the session works in, when it has one of its own. */
    worktree?: Worktree;
    /** The session of Pi's in the terminal this one continues, and how many messages its file had then. */
    fromPi?: { session: string; count: number };
    /**
     * The id of the person whose PiP this is: their assistant, which looks after their other sessions (`pip.ts`). PiP is
     * kept out of the session list; an older Pi Pocket, which does not know this field, lists it as a session.
     */
    pip?: string;
    /** Private-agent chat marker. Old unbound chats remain inert until an explicit owner reset. */
    pipAgent?: true;
    /** Stable persistent private identity; never inferred from a title or conversation ID. */
    pipAgentId?: string;
    /** Separate private work controller, not execution membership and not the global PiP panel. */
    pipWorkItemId?: string;
};

/** The catalogue of user-facing sessions: ownerless conversations created by the app. Subagents are not listed. */
export const SessionsDoc = defineDoc<{ items: Record<string, SessionMeta> }>({
    kind: "pocket.sessions",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** Favorite working folders in shortcut order, private to each person and shared by their devices. */
export const FolderFavoritesDoc = defineDoc<{ users: Record<string, string[]> }>({
    kind: "pocket.folder-favorites",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ users: {} }),
});

/**
 * The addresses this session knows its linked sessions by, so no session id goes into its transcript. A fork starts with
 * none, so it leaves the team: the addresses in the history it inherited do not resolve there.
 */
export const LinkedSessionPeersDoc = defineDoc<{ peers: Record<string, number> }>({
    kind: "pocket.linked-session-peers",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ peers: {} }),
});

/**
 * Messages between the linked sessions of one team since a person last wrote in any of them, kept on the team's top
 * session (`linked-sessions.ts`): past a limit, sessions stop messaging each other until a person writes.
 */
export const LinkedSessionRelayDoc = defineDoc<{ sent: number }>({
    kind: "pocket.linked-session-relay",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ sent: 0 }),
});

/**
 * What each call to start or message a linked session did, by its key hashed with the session: the session it made or
 * messaged, whom Pi worked for, and when. A call run again finds it, so it acts once. `linked-sessions.ts` keeps them
 * 30 days, and the newest 1000, as `shell.ts` keeps its requests. (Not a document family: those cannot be pruned.)
 */
export const LinkedSessionCallsDoc = defineDoc<{
    items: Record<string, { conversationId?: number; by?: string; at: number }>;
}>({
    kind: "pocket.linked-session-calls",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/** A project's path is metadata, never its identity or a grant of access to its threads. */
export type Project = {
    id: string;
    name: string;
    /** Omitted in projections for people invited to particular sessions. */
    cwd?: string;
    /** Creation-time default for new threads, omitted with cwd in scoped projections. */
    location?: WorkspaceLocation;
    createdAt: number;
    updatedAt: number;
    createdBy: string;
};

export type Projects = {
    projects: Record<string, Project & { cwd: string }>;
    /** Project-creation receipts are user-scoped hashes with input fingerprints. */
    requests: Record<string, { id: string; fingerprint: string }>;
};

/** One application-wide catalogue; never projected directly into a room. */
export const ProjectsDoc = defineDoc<Projects>({
    kind: "pocket.projects",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ projects: {}, requests: {} }),
});

/** Session-creation retries publish their result in the same commit as the new session. */
export const SessionCreatesDoc = defineDoc<{
    items: Record<string, { id: number; input: string }>;
}>({
    kind: "pocket.session-creates",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** A source fingerprint and branch identify one import, independently of prompt request IDs. */
export const ImportsDoc = defineDoc<{ items: Record<string, ConversationId> }>({
    kind: "pocket.imports",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** A takeover is reserved before stopping Pi. Its result commits with the import, so retries survive restart. */
export const TakeoversDoc = defineDoc<{
    items: Record<
        string,
        {
            session: ActivePi;
            startedAt: number;
            /** Confirmed publication intent survives an interrupted move; absent on older owner-only reservations. */
            visibility?: "owner" | "shared";
            result?: ConversationId;
        }
    >;
}>({
    kind: "pocket.takeovers",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** Private input admissions, not transcripts. Hashes identify targets; no text, commands or prompt digests are stored.
 * Prompt receipts mean possibly delivered, even after a crash, and block prompts plus automatic takeover.
 * Terminal receipts record known raw input without blocking Chat or import.
 * Neither kind expires or resets on a fresh snapshot/restart. This document must stay out of ROOM_DOCS.
 */
export const PrivateControlDoc = defineDoc<{
    items: Record<
        string,
        {
            id: string;
            instance: string;
            pane?: string;
            kind: "prompt" | "terminal";
            admittedAt: number;
        }
    >;
}>({
    kind: "pocket.private-control",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** Full source bytes and provenance. Not a room document; full archives are owner-only. */
export const ImportedSessionDoc = defineDoc<{
    archive: string;
    source?: {
        path: string;
        sha256: string;
        sessionId: string;
        leafId: string;
        importedBy: string;
        importedAt: number;
        entryIds: Record<string, number>;
    };
}>({
    kind: "pocket.imported-session",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ archive: "" }),
});

/**
 * Who wrote each user message, by entry id. `requesters` holds, for a message no person wrote (a parent's message to
 * its subagent), whose work it is: the person the parent worked for then. `requests` is unused.
 */
export const AuthorsDoc = defineDoc<{
    requests: Record<string, string>;
    entries: Record<string, string>;
    requesters?: Record<string, string>;
}>({
    kind: "pocket.authors",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ requests: {}, entries: {} }),
});

export type ReviewState = "pending" | "commented" | "approved" | "changes_requested" | "dismissed";

export type PipMentionState = {
    status: "queued" | "working" | "answered" | "unavailable" | "failed" | "interrupted";
    reason?: "paused" | "model" | "budget" | "permission" | "turn" | "capacity" | "source";
    replyId?: string;
};

export type ReviewSuggestionState = {
    status: "applying" | "applied" | "uncertain";
    by: string;
    at: number;
};

export type ReviewMessage = {
    id: string;
    userId: string;
    name: string;
    text: string;
    at: number;
    /** Application-authored discussion entry; never supplied by a human request. */
    service?: "pip";
    /** Application-authored attribution; no private PiP conversation identity or history is shared. */
    onBehalfOf?: { id: string; name: string };
    /** Native outcome of this person's explicit mention, not model-authored metadata. */
    pip?: PipMentionState;
    /** Human application receipts, keyed by zero-based top-level suggestion fence index. */
    suggestions?: Record<string, ReviewSuggestionState>;
    /** Captured destination/scope for this fresh suggestion source; not write authority by itself. */
    workspace?: string;
};

export type ReviewThread = ReviewMessage & {
    path?: string;
    side?: "old" | "new";
    /** Inclusive start; absent means a single line at `line`. */
    startLine?: number;
    line?: number;
    resolved: boolean;
    resolvedBy?: string;
    /** The last actual resolve/reopen actor, including delegated and reopening actions. */
    resolution?: Pick<ReviewMessage, "userId" | "name" | "at" | "service" | "onBehalfOf">;
    replies: ReviewMessage[];
};

export type ReviewRound = {
    id: string;
    title: string;
    status: "open" | "closed";
    createdBy: string;
    name: string;
    createdAt: number;
    /** Original app cwd at capture; saved diffs do not follow a later cwd change. */
    cwd: string;
    /** Git path prefix of the canonical capture folder; empty at repo root, otherwise ends in '/'. */
    scopePrefix: string;
    /** Incremented on every mutation; clients may guard actions with expectedRevision. */
    rev: number;
    snapshot: Changes;
    reviewers: Record<
        string,
        {
            userId: string;
            name: string;
            active: boolean;
            state: ReviewState;
            text?: string;
            at?: number;
        }
    >;
    threads: ReviewThread[];
    events: { userId: string; name: string; text: string; at: number }[];
};

/** Local review metadata and collaboration. A fork starts without its parent's reviews. */
export const ReviewDoc = defineDoc<{
    items: ReviewRound[];
    /** Opaque receipts for retried review actions; never projected into a room. */
    requests: Record<string, string>;
}>({
    kind: "pocket.reviews",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: [], requests: {} }),
});

/** Immutable complete diffs, keyed by review id. Not in ROOM_DOCS or inherited by forks. */
export const ReviewSnapshotDoc = defineDocFamily<
    { diffs: Record<string, string> },
    Record<string, never>
>({
    kind: "pocket.review-snapshot",
    version: 1,
    ...currentStateCheckpoints,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ diffs: {} }),
});

/** A comment's anchor is advisory; its client excerpt remains useful after files change. */
export type ChangeReviewThread = ReviewThread & {
    cwd: string;
    context?: string;
};

export type ChangeReviews = { threads: ChangeReviewThread[]; rev: number };

/** Comment-first collaboration. Legacy ReviewDoc/ReviewSnapshotDoc remain registered but unused. */
export const CommentReviewDoc = defineDoc<ChangeReviews & { requests: Record<string, string> }>({
    kind: "pocket.comment-reviews",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ threads: [], rev: 0, requests: {} }),
});

/** Private application claims survive lost acknowledgements/restarts; no claim is ever replayed as a write. */
export const ReviewSuggestionsDoc = defineDoc<{
    claims: Record<string, { workspace: string; path: string; expectedRevision: string }>;
}>({
    kind: "pocket.review-suggestions",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ claims: {} }),
});

/** Public references stamped by core onto a Reviewer's yielded assessment; never inferred from prose. */
export type PipDiffComment = {
    conversationId: number;
    threadId: string;
    commentId: string;
    path: string;
    side: "old" | "new";
    line: number;
    startLine?: number;
    text: string;
};

export type PipReviewReceipt = PipDiffComment & {
    fingerprint: string;
    /** First input submission of the actual Reviewer run; survives generation handovers. */
    episode: number;
    context: string;
    observation: string;
    origin: {
        requesterId: string;
        role: "reviewer";
        taskId: number;
        callId: string;
        generationId: number;
        provider: string;
        model: string;
    };
    at: number;
};

/** Internal publication receipts/provenance. Never projected into a room or inherited by forks. */
export const PipReviewCommentsDoc = defineDoc<{ receipts: Record<string, PipReviewReceipt> }>({
    kind: "pocket.pip-review-comments",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ receipts: {} }),
});

export type PipMentionSource =
    { kind: "chat"; messageId: string } | { kind: "review"; threadId: string; commentId: string };

export type PipMentionJob = {
    source: PipMentionSource;
    requesterId: string;
    authority: string;
    fingerprint: string;
    context: string;
    createdAt: number;
    selection: {
        provider: string;
        modelId: string;
        thinkingLevel: ModelThinkingLevel;
        revision: number;
    };
    taskId: number;
    status: "queued" | "dispatched" | "ready" | "delivered" | "failed" | "interrupted";
    /** Each returned model response has a separate immutable Spend receipt; result is the last response. */
    responses?: number;
    replyId?: string;
    result?: {
        text?: string;
        provider: string;
        model: string;
        usage: { [K in keyof Usage]: Usage[K] };
    };
};

/** Only the independent task lane and bounded active index; historical receipts live in job families. */
export const PipMentionsDoc = defineDoc<{
    lane?: number;
    active: Record<string, { source: number; taskId: number }>;
}>({
    kind: "pocket.pip-mentions",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ active: {} }),
});

/** One bounded, durable invocation per actual source message. Never inherited by a fork. */
export const PipMentionJobDoc = defineDocFamily<{ job?: PipMentionJob }, null>({
    kind: "pocket.pip-mention-job",
    version: 1,
    ...currentStateCheckpoints,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

export type ArtifactType = "html" | "markdown" | "svg";

export type ArtifactVersion = {
    version: number;
    /** The tool task that wrote it; a replayed call finds its version instead of writing another. */
    taskId: TaskId;
    /**
     * The call within that task. One codemode task makes many calls; versions from before this field match on the task
     * alone.
     */
    callId?: string;
    size: number;
    createdAt: number;
};

export type ArtifactMeta = {
    title: string;
    type: ArtifactType;
    versions: ArtifactVersion[];
};

/** The artifacts of one conversation, newest version last. Bodies live in `ArtifactBodyDoc`. */
export const ArtifactsDoc = defineDoc<{ items: Record<string, ArtifactMeta> }>({
    kind: "pocket.artifacts",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: {} }),
});

/** One artifact version's content, keyed `<artifactId>@<version>`. */
export const ArtifactBodyDoc = defineDocFamily<{ content: string }, { content: string }>({
    kind: "pocket.artifact-body",
    version: 1,
    ...currentStateCheckpoints,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: (seed) => ({ content: seed.content }),
});

export type SubagentRecord = {
    conversationId: ConversationId;
    /** Answers already reported to the parent: several messages can end in one answer, reported once. */
    reported: EntryId[];
    /** What the parent asked it last, the start of it, and when. */
    asked?: string;
    askedAt?: number;
    /**
     * When it last answered, or failed to (`failed`), what the parent asked, or, once it failed, a person's own message to
     * it; and why it failed, or that it was stopped.
     */
    answeredAt?: number;
    failed?: boolean;
    error?: string;
    /**
     * The failure a person dealt with (seen, or dismissed), by its `answeredAt`: it needs nobody now. A later failure has
     * a later time, so it needs them again.
     */
    dealtAt?: number;
};

/** A subagent's report waiting to go to its parent: all those waiting go together, as one message. */
export type PendingReport = { name: string; text: string };

/** Values codemode scripts keep with `store(key, value)`, read back with `load(key)` in later scripts. */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
    kind: "pocket.codemode-store",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ values: {} }),
});

/** A conversation's named background subagents, and the reporter task of each message sent to them. */
export const SubagentsDoc = defineDoc<{
    agents: Record<string, SubagentRecord>;
    reporters: Record<string, TaskId>;
    /** Reports not yet sent to the parent. */
    outbox?: PendingReport[];
    /** The task sending them, while there is one. */
    courier?: TaskId;
    /**
     * The batch taken from the outbox, kept until it has left the parent's queue, with the request id it goes with: a
     * courier that stops before then leaves it to the next, which sends it again under that id, so it goes once.
     */
    sending?: {
        request: string;
        reports: PendingReport[];
        /** A person took it out of the parent's queue (the queue's ×, or Stop): it is gone, not sent again. */
        discarded?: true;
    };
    /** How many batches went so far, for their request ids. */
    batches?: number;
    /**
     * Why the reports wait, while a spend limit holds them back: the parent would start a turn for them that its
     * session, or whoever pays there, may not pay for. They go when the limit is raised.
     */
    held?: string;
    /** An earlier build's names of the batch in the queue: no longer written, and cleared where found. */
    delivering?: string[];
}>({
    kind: "pocket.subagents",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    // A fork starts without subagents: they belong to the conversation that spawned them.
    fork: "initial",
    initial: () => ({ agents: {}, reporters: {} }),
});

export type ChatMessage = {
    /** Made from the client's request id, so a retried send does not post twice. */
    id: string;
    userId: string;
    /** The sender's name when sent, for people removed since. */
    name: string;
    text: string;
    at: number;
    /** "event": a line of activity ("Alex stopped the run"), not something someone wrote. */
    kind?: "event";
    /** People named with `@Name` in the text. */
    mentions?: string[];
    /** Application-owned PiP author/outcome and exact chat parent; ignored on human requests. */
    service?: "pip";
    pip?: PipMentionState;
    replyTo?: { id: string; name: string; text: string };
    /** A transcript message this one discusses. */
    quote?: { entryId: number; text: string };
};

/** The people's side chat in one conversation, oldest first, with activity lines. Pi does not see it. */
export const ChatDoc = defineDoc<{ messages: ChatMessage[] }>({
    kind: "pocket.chat",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ messages: [] }),
});

/** Messages a chat keeps; older ones drop off. */
export const CHAT_LIMIT = 500;

/** Emoji reactions to transcript entries: entry id → emoji → user ids. */
export const ReactionsDoc = defineDoc<{ entries: Record<string, Record<string, string[]>> }>({
    kind: "pocket.reactions",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ entries: {} }),
});

export type Pin = {
    /** `e<entryId>` or `c<chatId>`: pinning the same thing again unpins it. */
    id: string;
    entryId?: number;
    chatId?: string;
    /** A snippet of what was pinned, taken when pinned. */
    text: string;
    /** Who wrote the pinned message: a person's name or "Pi". */
    author: string;
    by: string;
    at: number;
};

/** Pinned messages of one conversation, newest last. */
export const PinsDoc = defineDoc<{ items: Pin[] }>({
    kind: "pocket.pins",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: [] }),
});

export type Notes = { text: string; rev: number; by?: string; at?: number };

/** One shared notes page per conversation. `rev` rises with every save, so two editors cannot overwrite each other unseen. */
export const NotesDoc = defineDoc<Notes>({
    kind: "pocket.notes",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ text: "", rev: 0 }),
});

export type Turns = { on: boolean; driver?: string; asks: string[] };

/** Take turns: while on, only the driver sends to Pi or changes its settings. */
export const TurnsDoc = defineDoc<Turns>({
    kind: "pocket.turns",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ on: false, asks: [] }),
});

export type Decision = { allow: boolean; by: string; userId: string; at: number };

/** Who allowed or denied each tool call Lancet Guard asked about, by tool call id. */
export const DecisionsDoc = defineDoc<{ calls: Record<string, Decision> }>({
    kind: "pocket.decisions",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ calls: {} }),
});

/** The text a subagent report starts with; the UI renders these as report cards. */
export const REPORT_PREFIX = "[subagent ";

/** Why a subagent that was stopped did not answer, in its report and its record. */
export const STOPPED = "stopped before it answered";

/** Plan mode: while on, Pi reads and proposes, and anything that would change something is blocked. */
export const PlanDoc = defineDoc<{ on: boolean; by?: string; at?: number }>({
    kind: "pocket.plan",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ on: false }),
});

export type Schedule = {
    /** Short and stable: what people and Pi use to cancel it. */
    id: string;
    /** What was asked for, as shown in the list. */
    text: string;
    /** What Pi gets: the text marked as scheduled, with who set it when several people use this server. */
    content: string;
    /** When it goes out next. */
    next: number;
    every?: Repeat;
    /** The time zone its clock times are in. */
    zone: string;
    /** Who set it; absent when Pi did. */
    by?: string;
    /** For one Pi set up: whom Pi worked for then. It goes out as Pi's, but as their work. */
    requestedBy?: string;
    createdAt: number;
    /** How many times it went out: each time sends with its own request id, so a restart never sends one twice. */
    runs: number;
    /** The durable task that sends it. */
    taskId: TaskId;
    /** Set by the same call already, when a tool call is replayed: its `taskId:callId`. */
    key?: string;
};

/** Messages that go to Pi later, or on repeat. A fork starts without them: they belong to who set them up. */
export const ScheduleDoc = defineDoc<{ items: Record<string, Schedule> }>({
    kind: "pocket.schedules",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/** The last check of a goal: whether it passed, its exit code, and the end of its output. */
export type GoalCheck = { passed: boolean; code: number; at: number; tail: string };

/**
 * "Done when": Pi keeps working until a check command passes, up to `max` checks. `counted` holds the generation
 * tasks whose answer was checked already, so an answer replayed after a restart is not counted twice.
 */
export type Goal = {
    command: string;
    by: string;
    max: number;
    tries: number;
    status: "working" | "met" | "gave-up";
    last?: GoalCheck;
    counted: string[];
};

export const GoalDoc = defineDoc<{ goal?: Goal }>({
    kind: "pocket.goal",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/**
 * What Pi spent for each person, in dollars: the work goes to whoever asked for it. `counted` is how much of each
 * conversation's spend is in `people` already, so every dollar is counted once, also across restarts.
 */
export const SpendDoc = defineDoc<{
    people: Record<string, number>;
    counted: Record<string, number>;
}>({
    kind: "pocket.spend",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ people: {}, counted: {} }),
});

/** A bounded auxiliary model response, independent of conversation turn attribution. */
export type AuxiliaryUsageRecord = {
    receiptId: string;
    requesterId: string;
    sourceConversationId: number;
    provider: string;
    model: string;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite1h?: number;
        reasoning?: number;
        totalTokens: number;
        cost: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            total: number;
        };
    };
};

/** One immutable receipt per source/receipt digest; not a room document or transcript. */
export const AuxiliaryUsageReceiptDoc = defineDocFamily<{ record?: AuxiliaryUsageRecord }, null>({
    kind: "pocket.auxiliary-usage-receipt",
    version: 1,
    ...currentStateCheckpoints,
    family: true,
    scope: "session",
    initial: () => ({}),
});

/** Cumulative auxiliary dollars, committed with receipts, never fed into pi.usage counting. */
export const AuxiliaryUsageDoc = defineDoc<{
    sources: Record<string, number>;
    people: Record<string, number>;
}>({
    kind: "pocket.auxiliary-usage",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ sources: {}, people: {} }),
});

export type Lesson = {
    /** Short and stable: what Pi and people use to change or remove it. */
    id: string;
    text: string;
    /** Private learned memory, derived only by the server from the bound chat. Never shared lessons. */
    privateAgent?: { ownerId: string; agentId: string };
    revision?: number;
    /** The project it is for (`memory.ts`: the repository's shared git folder, or the folder); absent: everywhere. */
    project?: string;
    /** The project's folder name, for people to read. */
    projectName?: string;
    /** The session it came from: a subagent's lesson is its session's. */
    from?: { conversationId: number; title: string };
    /** Who saved it, or whom Pi worked for when it did. */
    by: string;
    byPi: boolean;
    createdAt: number;
    updatedAt?: number;
    /** Saved by Pi, or by someone who is not the owner: unused until the owner approves it. */
    pending?: boolean;
    /**
     * A change to it in force that waits for the owner, as Pi or a guest proposed it: new text, or forgetting it. The
     * lesson stays as it is until then.
     */
    proposal?: { text?: string; forget?: boolean; by: string; byPi: boolean; at: number };
    /** The tool call that made it, `taskId:callId`: the call run again finds it instead of saving another. */
    key?: string;
};

/**
 * Memory: short lessons Pi keeps across sessions, by id, for one project or everywhere. Pi gets those that apply in
 * its system prompt (`extensions/memory.ts`).
 */
export const MemoryDoc = defineDoc<{ items: Record<string, Lesson> }>({
    kind: "pocket.memory",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/**
 * The page a conversation's browser last showed, and its size, to open it again after a restart. The page itself lives
 * in memory only (`browser.ts`).
 */
export const BrowserDoc = defineDoc<{
    url?: string;
    viewport?: { width: number; height: number; scale: number; mobile: boolean };
}>({
    kind: "pocket.browser",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

/**
 * The extensions' commands one person ran here, keyed by the person's id: each request id with its task, oldest first.
 * A request sent again, also after a restart, finds its task. A fork starts without them.
 */
export const CommandRequestsDoc = defineDocFamily<{ items: Record<string, number> }, null>({
    kind: "pocket.extension-command-request",
    version: 1,
    ...currentStateCheckpoints,
    family: true,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * The `!` commands people started here, by request id (`user:request`), oldest first: a request sent again after its
 * reply was lost runs its command once, also across a restart. A fork starts without them.
 */
export const ShellRequestsDoc = defineDoc<{ items: Record<string, number> }>({
    kind: "pocket.shell-requests",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * PiP's follows (`pip.ts`), by the key of the tool call that made each, so a call run again finds the follow it made.
 * `doneAt` marks one that reported (or was stopped); it stays a day, then goes.
 */
export const FollowsDoc = defineDoc<{
    items: Record<string, { taskId: number; session: number; at: number; doneAt?: number }>;
}>({
    kind: "pocket.pip-follows",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ items: {} }),
});

/**
 * Which provider pays, as PiP was last told to ask its person (`pip.ts`): the models their words named, at more than one
 * provider, and the newest entry of PiP's conversation then (`at`). Their next message answers it when it is just one of
 * those providers' whole name or id, in the same context.
 */
export type PipWorkQuestion = {
    id: string;
    text: string;
    at: number;
    /** Absent on historical questions, whose pending display is projected from this document. */
    entryId?: number;
    answer?: {
        text: string;
        by: string;
        requestId: string;
        at: number;
        /** Native composer identity; absent on historical orchestration-form answers. */
        submissionRequestId?: string;
        /** Authority fence when the immutable reply was saved, before native admission. */
        epoch?: number;
    };
    /** Unadmitted replies replaced by a fresh owner decision after an authority fence. */
    supersededAnswers?: NonNullable<PipWorkQuestion["answer"]>[];
};

/** Private supervisor memory and wake receipts; only the pending ask is projected in its owner's private room. */
export const PipWorkDoc = defineDoc<{
    goal: string;
    observed: string;
    sequence: number;
    pending?: {
        fingerprint: string;
        requestId: string;
        epoch: number;
        source: number;
        busy: boolean;
        taskId: number;
    };
    question?: PipWorkQuestion;
    questions: PipWorkQuestion[];
    actions: Record<string, { epoch: number; finish?: string }>;
    humanInputs: Record<string, true>;
    humanPending?: string;
    lastInput?: { requestId: string; epoch: number };
    reason?: string;
}>({
    kind: "pocket.pip-work",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({
        goal: "",
        observed: "",
        sequence: 0,
        questions: [],
        actions: {},
        humanInputs: {},
    }),
});

export const PipAskedDoc = defineDoc<{
    asked?: { models: { provider: string; id: string }[]; at: number };
}>({
    kind: "pocket.pip-asked",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/**
 * PiP's compactions whose summary PiP wrote itself (`pip-compact.ts`), by task id: their cost is in `pi.usage`, added
 * once. The newest few are kept.
 */
export const PipCompactionDoc = defineDoc<{ counted: number[] }>({
    kind: "pocket.pip-compaction",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ counted: [] }),
});

/** Whether a PR watch still looks (`watching`), or why it stopped. */
export type WatchStatus = "watching" | "merged" | "closed" | "gave-up" | "failed" | "expired";

/** A session's watch of its pull request (`watches.ts`). */
export type PrWatch = {
    /** `owner/name`, or `host/owner/name` for GitHub Enterprise. */
    repo: string;
    number: number;
    url: string;
    title: string;
    branch: string;
    /** The PR is in another repository than the session's folder: Pi is told to work in a checkout of it. */
    elsewhere?: boolean;
    /**
     * `gh`'s account could not push to the PR's repository when the watch began, so GitHub does not tell it who can
     * write there: members' and collaborators' remarks do not count, only the owner's (and bots' reviews).
     */
    unchecked?: boolean;
    /** Whose work it is: messages go to Pi for them, and their checks and spend limit apply. */
    by: string;
    /** Pi set it up, for `by`. */
    byPi?: boolean;
    createdAt: number;
    /** The durable task that looks. */
    taskId: TaskId;
    status: WatchStatus;
    /** When it looks next. */
    next: number;
    /** Messages sent to Pi, and the most it sends. */
    sent: number;
    max: number;
    /** Comments older than this were there before the watch: ISO time, as GitHub gives it. */
    since: string;
    /** Comments, reviews, and review comments told already, by id. */
    seen: string[];
    /** The commit whose failed checks Pi was told about, and the one whose conflicts. */
    failedSha?: string;
    conflictSha?: string;
    /** What the last look found, for the bar: the checks of the PR's last commit. */
    checks?: "pending" | "passed" | "failed" | "none";
    lastAt?: number;
    /** When it last found something to tell: two weeks with nothing and it stops. */
    lastNewsAt: number;
    /** Looks or sends in a row that failed, and why the last did: it stops after a while of them. */
    errors: number;
    note?: string;
    /** The tool call that set it up, so a replayed call finds it. */
    key?: string;
};

/** A session's PR watch. A fork starts without it: the PR is the session's. */
export const WatchDoc = defineDoc<{ watch?: PrWatch }>({
    kind: "pocket.pr-watch",
    version: 1,
    ...currentStateCheckpoints,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
});

/** A webhook (`hooks.ts`): an address that turns each post to it into a message to a session's Pi, or to PiP. */
export type Hook = {
    /** In its address, with the secret. */
    id: string;
    secret: string;
    name: string;
    /** What Pi should do with each post: the message's first part. */
    instructions: string;
    /** The session (or PiP) it messages. */
    target: number;
    /**
     * For GitHub: a post gets in only with GitHub's signature made with the secret, which is not in the address, so
     * whoever sees the address (a repository's admins do) cannot post as the hook. Absent: the secret is in the address.
     */
    signed?: boolean;
    /**
     * For GitHub: posts about what people outside the repository wrote (not its owner, nor members or collaborators who
     * can write to it) reach Pi too. Absent: they are dropped. Only a person sets it, in the hooks sheet.
     */
    anyone?: boolean;
    /** Who made it: posts go as their work, with their checks and spend limit. */
    by: string;
    createdAt: number;
    /** Posts that became messages, and when the last did. */
    count: number;
    lastAt?: number;
};

/** Every webhook, by id. */
export const HooksDoc = defineDoc<{ items: Record<string, Hook> }>({
    kind: "pocket.hooks",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});

/** What a repository watch looks for (`repo-watches.ts`). */
export type RepoEvent = "issues" | "pulls" | "ci" | "releases" | "mentions";

/**
 * A watch of a GitHub repository `gh`'s account can push to: what happens there (new issues and PRs, CI failing on a
 * branch, releases, @pi mentions) goes, with its person's standing instructions, to PiP or a session.
 */
export type RepoWatch = {
    /** Short and stable: what PiP and people use to remove it. */
    id: string;
    /** `owner/name`, or `host/owner/name` off github.com, as GitHub spells it. */
    repo: string;
    events: RepoEvent[];
    /** What to do when something comes: the message's first part. */
    instructions: string;
    /** Issues and PRs with this label only. */
    label?: string;
    /** Issues and PRs assigned to `gh`'s account only. */
    assigned?: boolean;
    /** The branch whose failing CI counts; the repository's default branch. */
    branch: string;
    /**
     * Issues and PRs from anyone, not only from the repository's owner, and members and collaborators who can write to
     * it (and bots' PRs).
     * Only a person turns it on, in the hooks sheet; PiP cannot.
     */
    anyone?: boolean;
    /** The conversation it messages: its person's PiP, or a session. */
    target: number;
    /** Whose work it is: messages go for them, with their checks and spend limit. */
    by: string;
    /** PiP set it up, for `by`. */
    byPi: boolean;
    createdAt: number;
    /** What happened before this (ISO, as GitHub writes times) was there before the watch. */
    since: string;
    taskId: TaskId;
    /** When it looks next. */
    next: number;
    /** What was told already, by kind and id (`i12`, `p7`, `r123`, `v9`, `c456`, `l789`). */
    seen: string[];
    /** Messages sent, and when the last one went. */
    count: number;
    lastNewsAt?: number;
    /** When it last looked, and how many looks in a row failed, with why the last did. */
    lastAt?: number;
    errors: number;
    note?: string;
    /** The tool call that set it up, so a replayed call finds it. */
    key?: string;
};

/** Every repository watch, by id. */
export const RepoWatchesDoc = defineDoc<{ items: Record<string, RepoWatch> }>({
    kind: "pocket.repo-watches",
    version: 1,
    ...currentStateCheckpoints,
    scope: "session",
    initial: () => ({ items: {} }),
});
