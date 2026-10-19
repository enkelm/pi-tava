// Picking a routing suggestion only edits the ordinary input draft; execution stays with submission.
const relationOf = (flag) => (flag === "--new" ? "new-work" : "same-work");

function routingOf(text, caret) {
    if (caret !== text.length) {
        return null;
    }

    const role = /^\/handoff[ \t]+([\w.:-]*)$/i.exec(text);
    const flagFirst = /^\/handoff[ \t]+(--same|--new)[ \t]+([\w.:-]*)$/i.exec(text);
    const roleFirst = /^\/handoff[ \t]+([\w.:-]+)[ \t]+(-[\w-]*)?$/i.exec(text);

    return role || flagFirst || roleFirst ? { role, flagFirst, roleFirst } : null;
}

export function isHandoffRouting(text, caret = text.length) {
    return routingOf(text, caret) !== null;
}

/** Complete routing arguments at the end of the draft, never words in the person's instructions. */
export function suggestHandoffs(text, options, caret = text.length) {
    const routing = routingOf(text, caret);

    if (!routing) {
        return [];
    }

    const { role, flagFirst, roleFirst } = routing;
    const choice = (option, name, completeOnEnter) => ({
        name,
        completion: `/${name} `,
        completeOnEnter,
        disabled: !option.enabled,
        args: option.relationship === "new-work" ? "New Work Item" : "Same Work Item",
        description: option.enabled
            ? (option.description ?? option.targetType)
            : (option.reason ?? "Unavailable from this thread"),
    });

    if (flagFirst) {
        const relation = relationOf(flagFirst[1].toLowerCase());
        const prefix = flagFirst[2].toLowerCase();

        return options
            .filter(
                (option) =>
                    option.relationship === relation &&
                    option.targetType.toLowerCase().startsWith(prefix),
            )
            .map((option) =>
                choice(
                    option,
                    `handoff ${flagFirst[1].toLowerCase()} ${option.targetType}`,
                    prefix !== option.targetType.toLowerCase(),
                ),
            );
    }

    if (roleFirst) {
        const target = roleFirst[1].toLowerCase();
        const prefix = roleFirst[2]?.toLowerCase() ?? "";

        return options
            .filter((option) => option.targetType.toLowerCase() === target)
            .map((option) => {
                const flag = option.relationship === "new-work" ? "--new" : "--same";

                return {
                    ...choice(
                        option,
                        `handoff ${option.targetType} ${flag}`,
                        prefix !== "" && prefix !== flag,
                    ),
                    flag,
                };
            })
            .filter((option) => option.flag.startsWith(prefix));
    }

    if (!role) {
        return [];
    }

    const prefix = role[1].toLowerCase();

    if (prefix.startsWith("-")) {
        return ["--same", "--new"]
            .filter((flag) => flag.startsWith(prefix))
            .map((flag) => {
                const choices = options.filter(
                    (option) => option.relationship === relationOf(flag),
                );
                const enabled = choices.some((option) => option.enabled);

                return {
                    name: `handoff ${flag}`,
                    completion: `/handoff ${flag} `,
                    completeOnEnter: true,
                    disabled: !enabled,
                    description: enabled
                        ? flag === "--new"
                            ? "Start a separate Work Item; choose a role next"
                            : "Continue this Work Item; choose a role next"
                        : (choices[0]?.reason ?? "No roles available"),
                };
            });
    }

    return options
        .filter((option) => option.targetType.toLowerCase().startsWith(prefix))
        .map((option) =>
            choice(
                option,
                `handoff ${option.targetType}${option.relationship === "new-work" ? " --new" : ""}`,
                prefix !== option.targetType.toLowerCase(),
            ),
        );
}
