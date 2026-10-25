// Project membership is metadata, never inferred from cwd or thread type.
export function sessionMatches(session, needle, { project, home } = {}) {
    if (!needle) {
        return true;
    }

    if (session.members?.some((member) => sessionMatches(member, needle, { project, home }))) {
        return true;
    }

    const cwd = session.cwd ?? "";
    const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

    return `${session.title ?? ""} ${cwd} ${short} ${session.model ?? ""} ${session.threadType ?? "worker"} ${project?.name ?? ""}`
        .toLowerCase()
        .includes(needle);
}

/** Identity context is a relationship, not a default choice, Chat placement or live control. */
export function projectAgentContext(project, namedAgents = []) {
    return {
        defaultAgent: namedAgents.find((agent) => agent.agentId === project.defaultAgentId),
        relatedAgents: namedAgents.filter((agent) => agent.projectId === project.id),
    };
}

/** Empty projects remain real sections. Exact control never changes Chat or Work Item placement. */
export function projectGroups(
    sessions,
    projects,
    { archived, needle, pinned, home, namedAgents = [] },
) {
    const available = sessions.filter((session) => Boolean(session.archived) === archived);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const matches = (session) =>
        sessionMatches(session, needle, {
            project: projectById.get(session.projectId),
            home,
        });
    const chatById = new Map();

    for (const agent of namedAgents) {
        for (const chat of agent.chats ?? []) {
            if (!chatById.has(chat.id)) {
                chatById.set(chat.id, { ...chat, agent });
            }
        }
    }

    const savedChats = [...chatById.values()].filter((chat) => Boolean(chat.archived) === archived);

    // A saved Chat appears once, in its actual project (or flat when unavailable/unassigned).
    // Control may nest co-located work, never duplicate a Chat or reclassify work placed elsewhere.
    const contents = (group, contextRows, contextMatch = false) => {
        const chats = savedChats
            .filter((chat) =>
                group.project
                    ? chat.projectId === group.project.id
                    : !projectById.has(chat.projectId),
            )
            .map((chat) => {
                // Passive, owner-private native ownership survives Stop/finish independently of
                // live supervisor authority. Identity, origin links and contacts are not substitutes.
                const controlled = contextRows.filter(
                    (row) =>
                        row.members &&
                        row.groupingParentChatId === chat.id &&
                        (row.projectId ?? null) === (chat.projectId ?? null),
                );
                const contextLabel = group.project
                    ? undefined
                    : chat.projectId == null
                      ? "No project"
                      : "Unavailable project";
                const chatMatch =
                    contextMatch ||
                    `${chat.title} ${chat.agent.name} ${contextLabel ?? ""}`
                        .toLowerCase()
                        .includes(needle);
                const rows = controlled.filter((row) => chatMatch || matches(row));

                return chatMatch || rows.length > 0
                    ? {
                          ...chat,
                          key: `${group.key}:chat:${chat.id}`,
                          contextLabel,
                          rows,
                      }
                    : null;
            })
            .filter(Boolean);
        const nested = new Set(chats.flatMap((chat) => chat.rows.map((row) => row.id)));
        const rows = contextRows.filter(
            (row) => contextMatch || matches(row) || nested.has(row.id),
        );

        return { ...group, rows, chats };
    };

    const groups = [];

    for (const project of projects) {
        const { defaultAgent: agent, relatedAgents } = projectAgentContext(project, namedAgents);
        const projectMatch =
            `${project.name} ${agent?.name ?? ""} ${relatedAgents.map((each) => each.name).join(" ")}`
                .toLowerCase()
                .includes(needle);
        const group = contents(
            { key: `project:${project.id}`, label: project.name, project, agent, relatedAgents },
            available.filter((session) => session.projectId === project.id),
            projectMatch,
        );

        if (
            (!archived || group.rows.length > 0 || group.chats.length > 0) &&
            (!needle || projectMatch || group.rows.length > 0 || group.chats.length > 0)
        ) {
            groups.push(group);
        }
    }

    const flat = contents(
        { key: "flat" },
        available.filter((session) => !projectById.has(session.projectId)),
    );
    const pins = [
        ...new Set(
            pinned
                .map((id) =>
                    flat.rows.find(
                        (session) =>
                            session.id === id ||
                            session.members?.some((member) => member.id === id),
                    ),
                )
                .filter(Boolean),
        ),
    ];

    return [
        ...groups,
        { ...flat, rows: [...pins, ...flat.rows.filter((session) => !pins.includes(session))] },
    ];
}

export function rowsInGroups(groups, isClosed = () => false) {
    return groups.flatMap((group) => {
        if (isClosed(group)) {
            return [];
        }

        const hidden = new Set(
            (group.chats ?? [])
                .filter((chat) => isClosed({ key: chat.key }))
                .flatMap((chat) => chat.rows.map((row) => row.id)),
        );

        return group.rows.filter((row) => !hidden.has(row.id));
    });
}
