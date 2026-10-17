// Argument matching owns draft completion only. App tests own admission; browser tests own input and sending.
import assert from "node:assert/strict";
import { test } from "node:test";

const modulePath: string = "../src/server/extensions/work-items/commands.js";
const { suggestHandoffs } = await import(modulePath);
const options = [
    { targetType: "researcher", relationship: "same-work", enabled: true },
    {
        targetType: "pull",
        relationship: "same-work",
        enabled: false,
        reason: "Wait for all helpers",
    },
    { targetType: "worker", relationship: "new-work", enabled: true },
    { targetType: "researcher", relationship: "new-work", enabled: true },
];

test("handoff role completion filters prefixes and distinguishes same work from new work", () => {
    const matches = suggestHandoffs("/handoff Re", options);

    assert.equal(matches.length, 2);
    assert.equal(matches[0].completion, "/handoff researcher ");
    assert.equal(matches[0].args, "Same Work Item");
    assert.equal(matches[1].completion, "/handoff researcher --new ");
    assert.equal(matches[1].args, "New Work Item");
    assert.equal(matches[0].completeOnEnter, true);
    assert.equal(suggestHandoffs("/handoff researcher", options)[0].completeOnEnter, false);
    assert.deepEqual(suggestHandoffs("/handoff unknown", options), []);
});

test("handoff relationship completion supports role-first and flag-first routing without assuming eligibility", () => {
    const flag = suggestHandoffs("/handoff --n", options);

    assert.equal(flag.length, 1);
    assert.equal(flag[0].completion, "/handoff --new ");
    const roles = suggestHandoffs(flag[0].completion, options);

    assert.equal(roles.length, 2);
    assert.ok(
        roles.every((row: { completion: string }) => row.completion.startsWith("/handoff --new ")),
    );
    assert.equal(
        suggestHandoffs("/handoff worker --n", options)[0].completion,
        "/handoff worker --new ",
    );
    assert.equal(
        suggestHandoffs("/handoff worker ", options)[0].completeOnEnter,
        false,
        "Enter after a complete role sends the command rather than choosing a different relationship",
    );
    assert.deepEqual(suggestHandoffs("/handoff pull --new", options), []);
});

test("handoff suggestions retain server refusal reasons and update when eligibility changes", () => {
    const [blocked] = suggestHandoffs("/handoff p", options);

    assert.equal(blocked.disabled, true);
    assert.equal(blocked.description, "Wait for all helpers");
    const fresh = options.map((option) => ({ ...option, enabled: true }));
    const [allowed] = suggestHandoffs("/handoff p", fresh);

    assert.equal(allowed.disabled, false);
    assert.notEqual(allowed.description, blocked.description);
    assert.equal(
        suggestHandoffs("/handoff --s", options)[0].disabled,
        false,
        "an available role keeps the relationship selectable even when another role is blocked",
    );
});

test("handoff completion leaves steering text, multiline prompts and edits away from the end alone", () => {
    for (const text of [
        "/handoff researcher Investigate retries",
        "/handoff worker --new Build the settings page",
        "/handoff --new worker Build a form",
        "/handoff researcher\nFocus on --new parsing",
        "/handoff researcher --new ",
        "/model re",
    ]) {
        assert.deepEqual(suggestHandoffs(text, options), [], text);
    }

    assert.deepEqual(
        suggestHandoffs("/handoff researcher", options, 12),
        [],
        "completion must not overwrite the remainder of an existing draft",
    );
});

test("namespaced profile completion preserves canonical identity and uses its registered description", () => {
    const custom = [
        {
            targetType: "custom-flow:Deep.Agent",
            relationship: "same-work",
            enabled: true,
            description: "Investigate this extension's bounded question",
        },
    ];
    const [role] = suggestHandoffs("/handoff CUSTOM-flow:de", custom);

    assert.equal(role.completion, "/handoff custom-flow:Deep.Agent ");
    assert.equal(role.description, custom[0]!.description);
    const [flag] = suggestHandoffs(role.completion + "--s", custom);

    assert.equal(flag.completion, "/handoff custom-flow:Deep.Agent --same ");
    assert.equal(
        suggestHandoffs("/handoff --same custom-flow:deep.agent", custom)[0].completeOnEnter,
        false,
    );
});
