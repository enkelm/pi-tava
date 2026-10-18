// The sidebar's project projection consumes the filtered catalogue and never infers placement from cwd.
import assert from "node:assert/strict";
import { test } from "node:test";

type Row = { id: number; projectId?: string; [field: string]: unknown };
type Group = { key: string; rows: Row[] };
type Filters = { archived: boolean; needle: string; pinned: number[]; home: string };

const {
    projectGroups,
    rowsInGroups,
}: {
    projectGroups: (
        rows: Row[],
        projects: { id: string; name: string }[],
        filters: Filters,
    ) => Group[];
    rowsInGroups: (groups: Group[], isClosed?: (group: Group) => boolean) => Row[];
} = await import(new URL("../web/project-groups.js", import.meta.url).href);
const { workItemRows }: { workItemRows: (rows: Row[]) => Row[] } = await import(
    new URL("../web/work-items.js", import.meta.url).href
);

const projects = [
    { id: "p-build", name: "Build", cwd: "/fixture/shared" },
    { id: "p-research", name: "Research", cwd: "/fixture/shared" },
];
const sessions = [
    { id: 1, title: "Initial thread", projectId: "p-build", cwd: "/fixture/shared", updatedAt: 20 },
    {
        id: 2,
        title: "Investigate rendering",
        projectId: "p-build",
        cwd: "/fixture/worktree",
        workItemId: "w-render",
        workItemTitle: "Render fixes",
        activeThreadId: 3,
        updatedAt: 10,
    },
    {
        id: 3,
        title: "Review rendering",
        projectId: "p-build",
        cwd: "/fixture/worktree",
        workItemId: "w-render",
        workItemTitle: "Render fixes",
        activeThreadId: 3,
        updatedAt: 11,
    },
    { id: 4, title: "One-time Chat", cwd: "/fixture/shared", updatedAt: 9 },
    {
        id: 5,
        title: "Archived investigation",
        projectId: "p-research",
        archived: true,
        updatedAt: 8,
    },
    { id: 6, title: "Archived build", projectId: "p-build", archived: true, updatedAt: 7 },
];

function grouped(archived = false, needle = "") {
    return projectGroups(workItemRows(sessions), projects, {
        archived,
        needle,
        pinned: [4, 2, 1],
        home: "/fixture/home",
    });
}

function contents(groups: ReturnType<typeof projectGroups>) {
    return groups.map((group) => [group.key, group.rows.map((row) => row.id)]);
}

test("projects directly contain standalone threads and Work Items, with independent folds and pins", () => {
    const groups = grouped();

    assert.deepEqual(
        contents(groups),
        [
            ["project:p-build", [1, 3]],
            ["project:p-research", []],
            ["flat", [4]],
        ],
        "an initial thread and a grouped item are peers; shared cwd and pins never reassign membership",
    );
    assert.deepEqual(
        rowsInGroups(groups).map((row) => row.id),
        [1, 3, 4],
    );
    assert.deepEqual(
        rowsInGroups(groups, (group) => group.key === "project:p-build").map((row) => row.id),
        [4],
        "folding a project hides its rows without folding unrelated projects or standalone Chats",
    );
});

test("project search includes Work Item members and archived views contain only archived rows", () => {
    assert.deepEqual(
        contents(grouped(false, "investigate rendering")),
        [
            ["project:p-build", [3]],
            ["flat", []],
        ],
        "a retired member's matching title keeps the Work Item in its project",
    );
    assert.deepEqual(
        contents(grouped(false, "research")),
        [
            ["project:p-research", []],
            ["flat", []],
        ],
        "an empty active project can still be found by name",
    );
    assert.deepEqual(contents(grouped(true)), [
        ["project:p-build", [6]],
        ["project:p-research", [5]],
        ["flat", []],
    ]);
});
