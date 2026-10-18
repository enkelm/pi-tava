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

/** Empty projects remain real sections. Pins never remove rows from their projects. */
export function projectGroups(sessions, projects, { archived, needle, pinned, home }) {
    const available = sessions.filter((session) => Boolean(session.archived) === archived);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const matches = (session) =>
        sessionMatches(session, needle, {
            project: projectById.get(session.projectId),
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
        const rows = available.filter(
            (session) => session.projectId === project.id && matches(session),
        );

        if ((!archived || rows.length > 0) && (!needle || projectMatch || rows.length > 0)) {
            groups.push({
                key: `project:${project.id}`,
                label: project.name,
                project,
                rows,
            });
        }
    }

    return [
        ...groups,
        { key: "flat", rows: [...pins, ...ordinary.filter((session) => !pins.includes(session))] },
    ];
}

export function rowsInGroups(groups, isClosed = () => false) {
    return groups.flatMap((group) => (isClosed(group) ? [] : group.rows));
}
