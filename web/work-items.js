// Work Items are built only from the server's access-filtered catalogue. They never reveal hidden members.

/** One visible sidebar entry per Work Item, driven by its active thread rather than a busy predecessor. */
export function workItemRows(sessions, enabled = true) {
    if (!enabled) {
        return sessions;
    }

    const items = new Map();

    for (const session of sessions) {
        if (session.workItemId) {
            const members = items.get(session.workItemId) ?? [];

            members.push(session);
            items.set(session.workItemId, members);
        }
    }

    const seen = new Set();
    const rows = [];

    for (const session of sessions) {
        if (!session.workItemId) {
            rows.push(session);
            continue;
        }

        if (seen.has(session.workItemId)) {
            continue;
        }

        seen.add(session.workItemId);
        // Durable conversation IDs preserve admission order, including same-role followups.
        const members = items.get(session.workItemId).sort((a, b) => a.id - b.id);
        const active = members.find((each) => each.id === session.activeThreadId);
        const representative = active ?? members[0];
        // Fresh successors are independent roots. Preserve the oldest visible member's external tree link
        // on the group row only; links between members must never turn into a group self-link.
        const linkedFrom = [representative.linkedFrom, members[0].linkedFrom].find(
            (link) => link && !members.some((member) => member.id === link.id),
        );

        rows.push({
            ...representative,
            linkedFrom: linkedFrom ? { ...linkedFrom } : undefined,
            title: session.workItemTitle ?? representative.title ?? "Work Item",
            busy: active?.busy ?? false,
            waiting: active?.waiting ?? false,
            workflow: active?.workflow,
            updatedAt: Math.max(...members.map((each) => each.updatedAt ?? 0)),
            members,
        });
    }

    // A linked child follows the visible Work Item even when its original parent is now a retired member.
    // These are presentation rows only: the catalogue and its stored links keep their original identifiers.
    const representatives = new Map(
        rows.flatMap((row) => (row.members ?? [row]).map((member) => [member.id, row.id])),
    );

    return rows
        .map((row) => {
            const parent = representatives.get(row.linkedFrom?.id);

            return parent !== undefined && parent !== row.linkedFrom.id
                ? { ...row, linkedFrom: { ...row.linkedFrom, id: parent } }
                : row;
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Group mutations have one request per Work Item, even when several of its members were selected. */
export function organizationTargets(ids, sessions, enabled = true) {
    const seen = new Set();
    const targets = [];

    for (const id of ids) {
        const session = sessions.find((each) => each.id === id);
        const workItemId = enabled ? session?.workItemId : null;
        const key = workItemId ? `work:${workItemId}` : `thread:${id}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        targets.push({
            id,
            workItemId,
            ids: workItemId
                ? sessions.filter((each) => each.workItemId === workItemId).map((each) => each.id)
                : [id],
        });
    }

    return targets;
}
