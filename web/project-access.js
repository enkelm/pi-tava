// Project grants reuse the project catalogue; choosing a bucket never discovers or connects to a host.
import { useEffect, useId, useState } from "preact/hooks";
import { actions, store } from "./store.js";
import { html, Icon, Loader } from "./ui.js";

const hostOf = (project) => (project.location?.kind === "ssh" ? project.location.host : null);

export function projectsMatchingFilter(projects, filter) {
    return projects.filter((project) =>
        filter === "local"
            ? hostOf(project) === null
            : filter.startsWith("ssh:")
              ? hostOf(project) === filter.slice(4)
              : true,
    );
}

/** A native horizontal scroller: long host names never widen the sheet or require a drag handler. */
export function ProjectFilters({ projects, filter, onChange, disabled = false, hosts = [] }) {
    const machines = [...new Set([...projects.map(hostOf).filter(Boolean), ...hosts])].sort();
    const choices = [
        ["all", "All"],
        ["local", "Local"],
        ...machines.map((host) => [`ssh:${host}`, host]),
    ];

    return html`<div
        class="gallery-tags project-filters"
        role="group"
        aria-label="Filter projects"
    >
        ${choices.map(
            ([value, label]) => html`<button
                key=${value}
                type="button"
                class=${`gallery-tag ${filter === value ? "on" : ""}`}
                aria-pressed=${filter === value}
                disabled=${disabled}
                onClick=${() => onChange(value)}
            >
                ${label}
            </button>`,
        )}
    </div>`;
}

export function ProjectAccessPicker({
    value,
    onChange,
    disabled = false,
    projects = store.state.projects,
    loaded = store.state.projectsLoaded,
}) {
    const [filter, setFilter] = useState("all");
    const [error, setError] = useState("");
    const helpId = useId();
    const access = value ?? {};
    const listed = projectsMatchingFilter(projects, filter);
    const host = filter.startsWith("ssh:") ? filter.slice(4) : null;
    const covered = (project) =>
        access.all === true ||
        (hostOf(project) === null
            ? access.local === true
            : access.hosts?.includes(hostOf(project)));
    const bucketSelected =
        access.all === true ||
        (filter === "local" ? access.local === true : host && access.hosts?.includes(host));
    const bucketLabel =
        filter === "all"
            ? "All projects"
            : filter === "local"
              ? "All local projects"
              : `All projects on ${host}`;

    const load = () => {
        setError("");
        actions.loadProjects().catch((failure) => setError(failure.message));
    };

    useEffect(() => {
        if (!loaded) {
            load();
        }
    }, []);

    const toggleBucket = (checked) => {
        const next = { ...access };

        if (filter === "all" || filter === "local") {
            if (checked) {
                next[filter] = true;
            } else {
                delete next[filter];
            }
        } else {
            const hosts = new Set(access.hosts ?? []);

            if (checked) {
                hosts.add(host);
            } else {
                hosts.delete(host);
            }

            if (hosts.size) {
                next.hosts = [...hosts];
            } else {
                delete next.hosts;
            }
        }

        onChange(next);
    };

    const toggleProject = (id, checked) => {
        const ids = new Set(access.projectIds ?? []);

        if (checked) {
            ids.add(id);
        } else {
            ids.delete(id);
        }

        const next = { ...access };

        if (ids.size) {
            next.projectIds = [...ids];
        } else {
            delete next.projectIds;
        }

        onChange(next);
    };

    return html`<div class="field project-access">
        <div class="label">Project access</div>
        <div class="muted small">
            Choose where they can read and start threads. Threads use the project's fixed machine and folder.
            Only the owner can choose machines or change folders.
        </div>
        <${ProjectFilters}
            projects=${projects}
            hosts=${access.hosts ?? []}
            filter=${filter}
            onChange=${setFilter}
            disabled=${disabled}
        />
        <div>
            <label class="check project-access-quick">
                <input
                    type="checkbox"
                    checked=${Boolean(bucketSelected)}
                    disabled=${disabled || (filter !== "all" && access.all === true)}
                    aria-describedby=${helpId}
                    onChange=${(event) => toggleBucket(event.currentTarget.checked)}
                />
                ${bucketLabel}
            </label>
            <div class="muted small" id=${helpId}>
                ${access.all && filter !== "all" ? "Included by All projects. " : ""}Includes future projects${host ? ` on ${host}` : filter === "local" ? " on this machine" : " on any machine"}.
                Individual choices below stay selected when a quick grant is turned off.
            </div>
        </div>
        ${!loaded && !error && html`<${Loader} label="Loading projects" />`}
        ${
            error &&
            html`<p class="error" role="alert">${error}</p>
                <button class="button" type="button" onClick=${load}>
                    Retry loading projects
                </button>`
        }
        <div class="sheet-list project-access-list">
            ${listed.map(
                (project) => html`<label
                    key=${project.id}
                    class="check project-access-row"
                >
                    <input
                        type="checkbox"
                        aria-label=${project.name}
                        checked=${Boolean(covered(project) || access.projectIds?.includes(project.id))}
                        disabled=${disabled || Boolean(covered(project))}
                        onChange=${(event) => toggleProject(project.id, event.currentTarget.checked)}
                    />
                    <span class="project-access-name">
                        ${project.name}
                        <span class="muted small project-access-meta">
                            <${Icon} name=${hostOf(project) ? "monitor" : "folder"} size=${13} />
                            ${hostOf(project) ?? "Local"} · ${project.cwd}
                            ${covered(project) ? " · Included by quick grant" : ""}
                        </span>
                    </span>
                </label>`,
            )}
        </div>
        ${loaded && listed.length === 0 && html`<p class="muted small">No projects${filter === "local" ? " on this machine" : host ? ` on ${host}` : " yet"}. Quick grants also include matching projects created later.</p>`}
        ${!access.all && !access.local && !access.hosts?.length && !access.projectIds?.length && html`<p class="muted small">No project access selected.</p>`}
    </div>`;
}
