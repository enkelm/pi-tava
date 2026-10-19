import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadType } from "./workflow-docs.ts";
import type { RemoteProjectTrustDecision } from "./remote-project-resources.ts";
import type { ProjectAccess } from "./project-access.ts";

/** The repository root: `web/`, `src/`, and `node_modules/` live here. */
export const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Where Pi Pocket keeps its database, users, uploads, and logs. */
export function dataDir(): string {
    return process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-durable-app");
}

/** owner: everything. guest: steers Pi (which can run commands here). viewer: reads, chats, and reacts, never steers. */
export type Role = "owner" | "guest" | "viewer";

export interface User {
    id: string;
    name: string;
    role: Role;
    /** sha256 of the user's login token; the token itself is only kept for the owner. */
    tokenHash: string;
    createdAt: number;
    lastSeen?: number;
    /** Session-only allowlist, when present; takes precedence over project selectors. */
    sessions?: string[];
    /** Owner-authored project grants. Absent retains legacy scope; new collaborator invites always include a grant. */
    projectAccess?: ProjectAccess;
    /** Owner-granted access to local Pi history; effective only for unrestricted steering guests. */
    continuePiSessions?: true;
    /**
     * The Cloudflare quick tunnel host (`abc-def.trycloudflare.com`) this person's device signed in through. Its sign-in
     * cookie works only there, and each tunnel gets a new address, so they are removed once that tunnel is gone.
     */
    tunnel?: string;
    /** The most Pi may spend for this person, in dollars; never for the owner. */
    budget?: number;
}

/** Local Pi history is private unless the owner explicitly grants an unrestricted steering guest access. */
export function canContinuePiSessions(user: User): boolean {
    return (
        user.role === "owner" ||
        (user.role === "guest" &&
            user.sessions === undefined &&
            user.projectAccess === undefined &&
            user.continuePiSessions === true)
    );
}

/** An invite not yet used, kept by its code's sha256 (the code itself is only shown to whoever made it). */
export interface StoredInvite {
    codeHash: string;
    role: Role;
    /** Optional session-only invitation; otherwise project grants apply. Never set for an owner invite. */
    session?: string;
    projectAccess?: ProjectAccess;
    /** Retained legacy history grants only; new project invitations cannot grant host Pi history. */
    continuePiSessions?: true;
    expiresAt: number;
    /** Who made it: it works only while they may still invite. */
    createdBy: string;
}

/** The theme (a theme folder's id, or "pocket") and bundled or theme-folder colors a browser
 * starts with until its person chooses. Desktop synchronization is not supported in Coop. */
export interface ThemeDefault {
    look: string;
    colors: string;
}
export interface ModelChoice {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
}

/** Public provider configuration only. Credentials remain in the provider host's auth store. */
export interface ProviderPackageSettings {
    baseUrl?: string;
    aliases?: Record<string, string>;
}

export interface ProviderPackageRelease {
    id: string;
    version: string;
    source: string;
}

export interface ProviderPackageSelection {
    name: string;
    enabled: boolean;
    release: ProviderPackageRelease;
    previous?: ProviderPackageRelease;
    settings?: ProviderPackageSettings;
}

export interface ProviderPackageState {
    packages: ProviderPackageSelection[];
    /** Last metadata-verified startup selection; requested changes do not mutate this. */
    applied?: { enabled: boolean; packages: ProviderPackageSelection[] };
}

interface PocketConfig {
    version: 1;
    /** Printed in the login URL at every start. Keep this file private. */
    ownerToken: string;
    users: User[];
    /** Invites not yet used: kept here so one that lasts a day or a week outlives a restart. */
    invites?: StoredInvite[];
    lastModel?: ModelChoice;
    /** The model and thinking level new sessions start with, as the owner chose; absent: the last one picked. */
    defaultModel?: ModelChoice;
    /** The theme and colors of browsers that have not chosen their own (`theme.js`), as the owner chose; absent: Pocket. */
    themeDefault?: ThemeDefault;
    /** Extension modules (file names in `src/server/extensions/`) the owner turned off. */
    disabledExtensions?: string[];
    /** Extension modules the owner turned on. Matters for modules that are off by default, like Lancet Guard. */
    enabledExtensions?: string[];
    /** "others": a guest cannot allow a risky call that their own message led to. Absent: anyone who can steer may. */
    approvals?: ApprovalRule;
    /** The tokens of context above which PiP compacts itself once idle; 0: only as sessions do. Absent: the default. */
    pipCompactAt?: number;
    /**
     * The owner's shared model list (`provider/modelId`). For background subagents, absent or empty leaves explicit
     * choices unrestricted; nonempty restricts extra models. The parent's model is always allowed. Linked sessions
     * always use this as an extra-model allowlist: absent or empty means parent only.
     */
    subagentModels?: string[];
    providerPackages?: ProviderPackageState;
    /** Owner-edited, app-wide role instructions. Missing roles use their bundled defaults. */
    agentPrompts?: Partial<Record<ThreadType, string>>;
    /** Owner choices for canonical SSH resource roots; never remote credentials or settings. */
    remoteProjectTrust?: RemoteProjectTrustDecision[];
}

/** Who may allow a risky tool call: anyone who can steer, or (for guests) only someone other than who asked. */
export type ApprovalRule = "anyone" | "others";

function newToken(): string {
    return randomBytes(24).toString("base64url");
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");

    return left.length === right.length && timingSafeEqual(left, right);
}

/** The most invites one person keeps live at once. */
export const MAX_INVITES = 50;

/** `config.json` in the data directory, written atomically with mode 0600. */
export class ConfigStore {
    readonly file: string;
    #config: PocketConfig;

    constructor(directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.file = join(directory, "config.json");

        if (existsSync(this.file)) {
            this.#config = JSON.parse(readFileSync(this.file, "utf8")) as PocketConfig;
        } else {
            const ownerToken = newToken();

            this.#config = {
                version: 1,
                ownerToken,
                users: [
                    {
                        id: randomUUID(),
                        name: "Owner",
                        role: "owner",
                        tokenHash: hashToken(ownerToken),
                        createdAt: Date.now(),
                    },
                ],
            };
            this.save();
        }
    }

    get ownerToken(): string {
        return this.#config.ownerToken;
    }

    get users(): readonly User[] {
        return this.#config.users;
    }

    get lastModel(): ModelChoice | undefined {
        return this.#config.lastModel;
    }

    set lastModel(choice: ModelChoice | undefined) {
        this.#config.lastModel = choice;
        this.save();
    }

    get themeDefault(): ThemeDefault | undefined {
        return this.#config.themeDefault;
    }

    set themeDefault(choice: ThemeDefault | undefined) {
        if (choice === undefined) {
            delete this.#config.themeDefault;
        } else {
            this.#config.themeDefault = choice;
        }

        this.save();
    }

    get defaultModel(): ModelChoice | undefined {
        return this.#config.defaultModel;
    }

    set defaultModel(choice: ModelChoice | undefined) {
        if (choice === undefined) {
            delete this.#config.defaultModel;
        } else {
            this.#config.defaultModel = choice;
        }

        this.save();
    }

    /** The owner's choice of when PiP compacts itself (`pip-compact.ts`); undefined: its default. */
    get pipCompactAt(): number | undefined {
        return this.#config.pipCompactAt;
    }

    set pipCompactAt(tokens: number | undefined) {
        if (tokens === undefined) {
            delete this.#config.pipCompactAt;
        } else {
            this.#config.pipCompactAt = tokens;
        }

        this.save();
    }

    /** Shared model list: empty means unrestricted background choices, but parent-only linked sessions. */
    get subagentModels(): readonly string[] {
        const models = this.#config.subagentModels;

        // Read from a file people may have edited: only strings count.
        return Array.isArray(models) ? models.filter((each) => typeof each === "string") : [];
    }

    set subagentModels(models: readonly string[]) {
        if (models.length === 0) {
            delete this.#config.subagentModels;
        } else {
            this.#config.subagentModels = [...models];
        }

        this.save();
    }

    get approvalRule(): ApprovalRule {
        return this.#config.approvals ?? "anyone";
    }

    set approvalRule(rule: ApprovalRule) {
        if (rule === "anyone") {
            delete this.#config.approvals;
        } else {
            this.#config.approvals = rule;
        }

        this.save();
    }

    get providerPackages(): ProviderPackageState {
        return structuredClone(this.#config.providerPackages ?? { packages: [] });
    }

    set providerPackages(state: ProviderPackageState) {
        const previous = this.#config.providerPackages;

        this.#config.providerPackages = structuredClone(state);

        try {
            this.save();
        } catch (error) {
            this.#config.providerPackages = previous;

            throw error;
        }
    }

    get agentPrompts(): Partial<Record<ThreadType, string>> {
        return { ...this.#config.agentPrompts };
    }

    set agentPrompts(prompts: Partial<Record<ThreadType, string>>) {
        const previous = this.#config.agentPrompts;

        this.#config.agentPrompts = { ...prompts };

        try {
            this.save();
        } catch (error) {
            this.#config.agentPrompts = previous;

            throw error;
        }
    }

    get remoteProjectTrust(): readonly RemoteProjectTrustDecision[] {
        const decisions = this.#config.remoteProjectTrust ?? [];

        if (!Array.isArray(decisions)) {
            throw new Error("The host's remote project trust choices cannot be read.");
        }

        return decisions.map((entry) => ({ ...entry }));
    }

    set remoteProjectTrust(decisions: readonly RemoteProjectTrustDecision[]) {
        if (decisions.length > 2048) {
            throw new Error("Remote project trust is limited to 2048 explicit choices.");
        }

        const previous = this.#config.remoteProjectTrust;

        this.#config.remoteProjectTrust = decisions.map(({ filesystem, path, trusted }) => ({
            filesystem,
            path,
            trusted,
        }));

        try {
            this.save();
        } catch (error) {
            this.#config.remoteProjectTrust = previous;

            throw error;
        }
    }

    get disabledExtensions(): readonly string[] {
        return this.#config.disabledExtensions ?? [];
    }

    get enabledExtensions(): readonly string[] {
        return this.#config.enabledExtensions ?? [];
    }

    /** Whether the owner turned a module on or off; undefined when they never chose, so its default applies. */
    extensionChoice(file: string): boolean | undefined {
        if (this.#config.disabledExtensions?.includes(file)) {
            return false;
        }

        if (this.#config.enabledExtensions?.includes(file)) {
            return true;
        }

        return undefined;
    }

    setExtensionEnabled(file: string, enabled: boolean): void {
        const disabled = new Set(this.#config.disabledExtensions ?? []);
        const turnedOn = new Set(this.#config.enabledExtensions ?? []);

        if (enabled) {
            disabled.delete(file);
            turnedOn.add(file);
        } else {
            disabled.add(file);
            turnedOn.delete(file);
        }

        if (disabled.size === 0) {
            delete this.#config.disabledExtensions;
        } else {
            this.#config.disabledExtensions = [...disabled].sort();
        }

        if (turnedOn.size === 0) {
            delete this.#config.enabledExtensions;
        } else {
            this.#config.enabledExtensions = [...turnedOn].sort();
        }

        this.save();
    }

    userByToken(token: string): User | undefined {
        const hash = hashToken(token);

        return this.#config.users.find((user) => sameHash(user.tokenHash, hash));
    }

    userById(id: string): User | undefined {
        return this.#config.users.find((user) => user.id === id);
    }

    addUser(
        name: string,
        role: Role,
        sessions?: string[],
        continuePiSessions?: true,
        projectAccess?: ProjectAccess,
    ): { user: User; token: string } {
        const token = newToken();
        const user: User = {
            id: randomUUID(),
            name,
            role,
            tokenHash: hashToken(token),
            createdAt: Date.now(),
            ...(sessions === undefined ? {} : { sessions: [...sessions] }),
            ...(role === "owner" || projectAccess === undefined
                ? {}
                : { projectAccess: structuredClone(projectAccess) }),
            ...(role === "guest" &&
            sessions === undefined &&
            projectAccess === undefined &&
            continuePiSessions === true
                ? { continuePiSessions: true as const }
                : {}),
        };

        this.#config.users.push(user);
        this.save();

        return { user, token };
    }

    updateUser(
        id: string,
        patch: Partial<
            Pick<
                User,
                | "name"
                | "lastSeen"
                | "role"
                | "sessions"
                | "projectAccess"
                | "tunnel"
                | "budget"
                | "continuePiSessions"
            >
        >,
    ): void {
        const user = this.userById(id);

        if (user === undefined) {
            return;
        }

        // The owner stays the owner, and nobody else becomes one.
        if (patch.role !== undefined && (user.role === "owner" || patch.role === "owner")) {
            delete patch.role;
        }

        if ("sessions" in patch && user.role === "owner") {
            delete patch.sessions;
        }

        if ("projectAccess" in patch && user.role === "owner") {
            delete patch.projectAccess;
        }

        if ("budget" in patch && user.role === "owner") {
            delete patch.budget;
        }

        Object.assign(user, patch);

        if (user.sessions === undefined) {
            delete user.sessions;
        }

        if (user.budget === undefined) {
            delete user.budget;
        }

        if (
            user.role !== "guest" ||
            user.sessions !== undefined ||
            user.projectAccess !== undefined ||
            user.continuePiSessions !== true
        ) {
            delete user.continuePiSessions;
        }

        this.save();
    }

    /** Remove someone (never the owner), and the invites they made, which could no longer be used. */
    removeUser(id: string): void {
        this.#config.users = this.#config.users.filter(
            (user) => user.id !== id || user.role === "owner",
        );

        if (!this.#config.users.some((user) => user.id === id)) {
            this.#config.invites = this.#config.invites?.filter(
                (invite) => invite.createdBy !== id,
            );
        }

        this.save();
    }

    /** Keep a new invite. A person keeps at most `MAX_INVITES` live: beyond that, their oldest ends. */
    addInvite(code: string, invite: Omit<StoredInvite, "codeHash">): void {
        this.#pruneInvites();
        const theirs = (this.#config.invites ?? []).filter(
            (each) => each.createdBy === invite.createdBy,
        );
        const ending = new Set(theirs.slice(0, Math.max(0, theirs.length - MAX_INVITES + 1)));

        this.#config.invites = [
            ...(this.#config.invites ?? []).filter((each) => !ending.has(each)),
            { codeHash: hashToken(code), ...invite },
        ];
        this.save();
    }

    /** A live invite by its code, or undefined when there is none or it expired. */
    invite(code: string): StoredInvite | undefined {
        this.#pruneInvites();
        const hash = hashToken(code);

        return this.#config.invites?.find((invite) => sameHash(invite.codeHash, hash));
    }

    /** Remove an invite, and say whether it was there (and live). */
    removeInvite(code: string): boolean {
        const found = this.invite(code);

        if (found === undefined) {
            return false;
        }

        this.#config.invites = this.#config.invites?.filter((invite) => invite !== found);
        this.save();

        return true;
    }

    #pruneInvites(): void {
        const now = Date.now();
        const live = (this.#config.invites ?? []).filter((invite) => invite.expiresAt >= now);

        if (live.length !== (this.#config.invites ?? []).length) {
            this.#config.invites = live;
            this.save();
        }
    }

    /**
     * Replace the owner token, signing out every device that used the old one. Owner invites not yet used go too: one
     * spent later would hand out the new token.
     */
    rotateOwnerToken(): string {
        const token = newToken();

        this.#config.ownerToken = token;
        const owner = this.#config.users.find((user) => user.role === "owner");

        if (owner !== undefined) {
            owner.tokenHash = hashToken(token);
        }

        if (this.#config.invites !== undefined) {
            this.#config.invites = this.#config.invites.filter((invite) => invite.role !== "owner");
        }

        this.save();

        return token;
    }

    save(): void {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;

        writeFileSync(temp, `${JSON.stringify(this.#config, null, "\t")}\n`, { mode: 0o600 });
        renameSync(temp, this.file);
        chmodSync(this.file, 0o600);
    }
}
