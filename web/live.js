// Reconstruct the message Pi is writing from protocol 3 view updates, or accept an older server's whole message.

/**
 * The live message after `update`, given the `current` one. Unchanged blocks keep their identity, and an unchanged
 * message returns `current` itself. Null means the delta does not fit: the store must reconnect for a full view.
 */
export function liveMessage(current, update) {
    if (update?.keep === undefined) {
        return update;
    }

    const had = current?.blocks ?? [];
    const { keep, blocks: changed } = update;

    if (!Number.isSafeInteger(keep) || keep < 0 || keep > had.length || !Array.isArray(changed)) {
        return null;
    }

    const [first, ...rest] = changed;

    if (
        first?.from !== undefined &&
        ((first.type !== "text" && first.type !== "thinking") ||
            had[keep]?.type !== first.type ||
            had[keep].text.length !== first.from)
    ) {
        return null;
    }

    if (changed.length === 0 && keep === had.length) {
        return current;
    }

    return {
        blocks:
            first?.from === undefined
                ? [...had.slice(0, keep), ...changed]
                : [
                      ...had.slice(0, keep),
                      { ...had[keep], text: had[keep].text + first.text },
                      ...rest,
                  ],
    };
}
