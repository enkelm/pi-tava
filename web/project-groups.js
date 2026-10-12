// Project/goal membership is metadata, never inferred from cwd or thread type.
export function sessionMatches(session, needle, { project, goal, home } = {}) {
    if (!needle) {
        return true;
    }

    if (
        session.members?.some((member) => sessionMatches(member, needle, { project, goal, home }))
    ) {
        return true;
    }

    const cwd = session.cwd ?? "";
    const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

    return `${session.title ?? ""} ${cwd} ${short} ${session.model ?? ""} ${session.threadType ?? "worker"} ${project?.name ?? ""} ${goal?.name ?? ""}`
        .toLowerCase()
        .includes(needle);
}

/** Empty projects and goals remain real sections. Pins never remove rows from their goals. */
export function projectGroups(sessions, projects, goals, { archived, needle, pinned, home }) {
    const available = sessions.filter((session) => Boolean(session.archived) === archived);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const goalById = new Map(goals.map((goal) => [goal.id, goal]));
    const matches = (session) =>
        sessionMatches(session, needle, {
            project: projectById.get(session.projectId),
            goal: goalById.get(session.goalId),
            home,
        });
    const ordinary = available.filter(
        (session) => !projectById.has(session.projectId) && matches(session),
    );
    const pins = [
        ...new Set(
            pinned
                .map((id) =>
                    ordinary.find(
                        (session) =>
                            session.id === id ||
                            session.members?.some((member) => member.id === id),
                    ),
                )
                .filter(Boolean),
        ),
    ];
    const groups = [];

    for (const project of projects) {
        const projectMatch = project.name.toLowerCase().includes(needle);
        const memberRows = available.filter((session) => session.projectId === project.id);
        const children = [];

        for (const goal of goals.filter((each) => each.projectId === project.id)) {
            const rows = memberRows.filter(
                (session) => session.goalId === goal.id && matches(session),
            );
            const goalMatch = goal.name.toLowerCase().includes(needle);
            const inView = archived
                ? goal.archived || rows.length > 0
                : !goal.archived || rows.length > 0;

            if (inView && (!needle || projectMatch || goalMatch || rows.length > 0)) {
                children.push({
                    key: `goal:${goal.id}`,
                    label: goal.name,
                    goal,
                    project,
                    rows,
                    children: [],
                });
            }
        }

        const rows = memberRows.filter((session) => {
            const goal = goalById.get(session.goalId);

            return (!goal || goal.projectId !== project.id) && matches(session);
        });

        if (
            (!archived || rows.length > 0 || children.length > 0) &&
            (!needle || projectMatch || rows.length > 0 || children.length > 0)
        ) {
            groups.push({
                key: `project:${project.id}`,
                label: project.name,
                project,
                rows,
                children,
            });
        }
    }

    return [
        ...groups,
        { key: "flat", rows: [...pins, ...ordinary.filter((session) => !pins.includes(session))] },
    ];
}

export function rowsInGroups(groups, isClosed = () => false) {
    return groups.flatMap((group) =>
        isClosed(group) ? [] : [...group.rows, ...rowsInGroups(group.children ?? [], isClosed)],
    );
}
