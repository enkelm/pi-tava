/** Declarative session profiles and transitions; registration never grants execution authority. */

export interface AgentProfile {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    readonly title: string;
    readonly icon?: string;
    readonly starter?: boolean;
}

export interface SessionWorkflowTransition {
    readonly from: string;
    readonly to: string;
    readonly relationship: "same-work" | "new-work";
    readonly historyAny?: readonly string[];
    /** When supplied, the current checkout must have exactly this dirty/clean state. */
    readonly currentDiff?: boolean;
}

export interface SessionWorkflow {
    readonly id: string;
    readonly profiles: readonly AgentProfile[];
    readonly transitions: readonly SessionWorkflowTransition[];
}

export interface SessionWorkflowOption {
    targetType: string;
    relationship: "same-work" | "new-work";
    currentDiff?: boolean;
}

const MODULE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LEGACY_PROFILES = new Set([
    "chat",
    "researcher",
    "worker",
    "reviewer",
    "follow-up",
    "pull",
    "land",
    "publish",
]);
const MAX_PROFILES = 64;
const MAX_TRANSITIONS = 512;
const MAX_PROMPT = 32_000;

function fail(message: string): never {
    throw new Error(`web.workflow: ${message}`);
}

/** Only plain data fields are accepted, including fields TypeScript's structural typing may overlook. */
function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${label} must be an object`);
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        fail(`${label} must be a plain data object`);
    }

    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !fields.includes(key)) {
            fail(`${label} has an unknown field`);
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;

        if (!("value" in descriptor)) {
            fail(`${label}.${key} must be data, not an accessor`);
        }
    }

    return value as Record<string, unknown>;
}

function list(value: unknown, label: string, max: number, min = 0): unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
        fail(`${label} must be a list of ${min}–${max} entries`);
    }

    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }

        if (
            typeof key !== "string" ||
            !/^(?:0|[1-9][0-9]*)$/.test(key) ||
            Number(key) >= value.length
        ) {
            fail(`${label} has an unknown field`);
        }

        if (!("value" in Object.getOwnPropertyDescriptor(value, key)!)) {
            fail(`${label} entries must be data, not accessors`);
        }
    }

    for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
            fail(`${label} must not contain missing entries`);
        }
    }

    return value;
}

function text(value: unknown, label: string, max: number): string {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > max ||
        value.includes("\0")
    ) {
        fail(`${label} must be nonempty text of at most ${max} characters without NUL`);
    }

    return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
    if (value !== undefined && typeof value !== "boolean") {
        fail(`${label} must be a boolean`);
    }

    return value;
}

function identity(value: unknown, module: string, reserved: boolean, label: string): string {
    const id = text(value, label, 129);
    const local = id.startsWith(`${module}:`) ? id.slice(module.length + 1) : undefined;

    if (!reserved && (local === undefined || !LOCAL_ID.test(local))) {
        fail(`${label} must start with ${module}: and end in 1–64 letters, digits, . _ or -`);
    }

    return id;
}

/**
 * Clone and freeze one module's definition before staging it. The loader, not extension data, supplies trust.
 * Only the trusted built-in work-items.ts may use the stored legacy identities, even when it is disabled.
 */
export function validateWorkflow(
    module: string,
    definition: SessionWorkflow,
    builtIn: boolean,
): Readonly<SessionWorkflow> {
    if (!MODULE.test(module)) {
        fail("the registering module needs a valid module name");
    }

    const builtin = builtIn === true && module === "work-items";
    const data = record(definition, ["id", "profiles", "transitions"], "definition");
    const id = identity(data.id, module, builtin && data.id === "work-items", "id");
    const seen = new Set<string>();
    const profiles = list(data.profiles, "profiles", MAX_PROFILES, 1).map((value, index) => {
        const label = `profiles[${index}]`;
        const profile = record(
            value,
            ["id", "name", "description", "prompt", "title", "starter", "icon"],
            label,
        );
        const profileId = identity(
            profile.id,
            module,
            builtin && typeof profile.id === "string" && LEGACY_PROFILES.has(profile.id),
            `${label}.id`,
        );

        if (seen.has(profileId)) {
            fail(`profile ${profileId} is registered twice`);
        }

        seen.add(profileId);
        const starter = optionalBoolean(profile.starter, `${label}.starter`);

        return Object.freeze({
            id: profileId,
            name: text(profile.name, `${label}.name`, 160),
            description: text(profile.description, `${label}.description`, 2000),
            prompt: text(profile.prompt, `${label}.prompt`, MAX_PROMPT),
            title: text(profile.title, `${label}.title`, 160),
            ...(starter === undefined ? {} : { starter }),
            ...(profile.icon === undefined
                ? {}
                : { icon: text(profile.icon, `${label}.icon`, 64) }),
        });
    });
    const tuples = new Set<string>();

    const reference = (value: unknown, label: string) => {
        const profileId = text(value, label, 129);

        if (!seen.has(profileId)) {
            fail(`${label} must reference a profile in this workflow`);
        }

        return profileId;
    };

    const transitions = list(data.transitions, "transitions", MAX_TRANSITIONS).map(
        (value, index): SessionWorkflowTransition => {
            const label = `transitions[${index}]`;
            const transition = record(
                value,
                ["from", "to", "relationship", "historyAny", "currentDiff"],
                label,
            );
            const from = reference(transition.from, `${label}.from`);
            const to = reference(transition.to, `${label}.to`);
            const relationship = transition.relationship;

            if (relationship !== "same-work" && relationship !== "new-work") {
                fail(`${label}.relationship must be same-work or new-work`);
            }

            const tuple = JSON.stringify([from, to, relationship]);

            if (tuples.has(tuple)) {
                fail(`${label} duplicates a from/to/relationship transition`);
            }

            tuples.add(tuple);
            const historyAny =
                transition.historyAny === undefined
                    ? undefined
                    : list(transition.historyAny, `${label}.historyAny`, profiles.length, 1).map(
                          (item, at) => reference(item, `${label}.historyAny[${at}]`),
                      );

            if (historyAny !== undefined && new Set(historyAny).size !== historyAny.length) {
                fail(`${label}.historyAny must not repeat profiles`);
            }

            const currentDiff = optionalBoolean(transition.currentDiff, `${label}.currentDiff`);

            return Object.freeze({
                from,
                to,
                relationship,
                ...(historyAny === undefined ? {} : { historyAny: Object.freeze(historyAny) }),
                ...(currentDiff === undefined ? {} : { currentDiff }),
            });
        },
    );

    return Object.freeze({
        id,
        profiles: Object.freeze(profiles),
        transitions: Object.freeze(transitions),
    });
}

/** Data-level choices only. Core checks currentDiff, access, ownership and execution capabilities at admission. */
export function workflowOptions(
    workflow: SessionWorkflow | undefined,
    current: string,
    history: readonly string[],
): SessionWorkflowOption[] {
    if (workflow === undefined || !workflow.profiles.some((profile) => profile.id === current)) {
        return [];
    }

    return workflow.transitions
        .filter(
            (transition) =>
                transition.from === current &&
                (transition.historyAny === undefined ||
                    transition.historyAny.some((profileId) => history.includes(profileId))),
        )
        .map((transition) => ({
            targetType: transition.to,
            relationship: transition.relationship,
            ...(transition.currentDiff === undefined
                ? {}
                : { currentDiff: transition.currentDiff }),
        }));
}
