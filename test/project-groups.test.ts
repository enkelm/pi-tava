// The sidebar's project projection consumes the filtered catalogue and never infers placement from cwd.
import assert from "node:assert/strict";
import { test } from "node:test";

type Row = { id: number; projectId?: string; [field: string]: unknown };
type Chat = { id: number; title: string; projectId?: string; archived?: boolean };
type Agent = { agentId: string; name: string; chats?: Chat[] };
type Group = {
    key: string;
    rows: Row[];
    agent?: Agent;
    chats?: (Chat & {
        agent: Agent;
        rows: Row[];
        key: string;
        contextLabel?: string;
    })[];
};
type Filters = {
    archived: boolean;
    needle: string;
    pinned: number[];
    home: string;
    namedAgents?: Agent[];
};

const {
    projectGroups,
    rowsInGroups,
}: {
    projectGroups: (
        rows: Row[],
        projects: { id: string; name: string; defaultAgentId?: string }[],
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

test("project headings keep the explicit default while related identity names remain searchable", () => {
    const namedAgents = [
        { agentId: "nora", name: "Nora" },
        { agentId: "max", name: "Max", projectId: "p-build" },
    ];
    const projectsWithAgents = [
        { ...projects[0]!, defaultAgentId: "nora" },
        { ...projects[1]!, defaultAgentId: "removed" },
    ];
    const filters = { archived: false, needle: "", pinned: [], home: "/fixture/home", namedAgents };
    const groups = projectGroups(workItemRows(sessions), projectsWithAgents, filters);

    assert.ok(groups[0]);
    assert.ok(groups[1]);
    assert.equal(groups[0].agent?.agentId, "nora");
    assert.equal(
        groups[1].agent,
        undefined,
        "an unavailable default never borrows a different identity",
    );

    for (const needle of ["nora", "max"]) {
        assert.deepEqual(
            projectGroups([], projectsWithAgents, { ...filters, needle }).map((group) => group.key),
            ["project:p-build", "flat"],
            "an empty project remains discoverable by its default or a separately linked identity",
        );
    }
});

test("each exact Chat appears once and nests only co-located work without changing actual placement", () => {
    const namedAgents = [
        {
            agentId: "nora",
            name: "Nora",
            projectId: "p-build",
            chats: [
                { id: 100, title: "First Chat", projectId: "p-build" },
                { id: 101, title: "Second Chat", projectId: "p-build" },
                { id: 102, title: "No project" },
                { id: 103, title: "Closed Chat", projectId: "p-build", archived: true },
                { id: 104, title: "Unavailable context", projectId: "p-removed" },
                { id: 100, title: "First Chat", projectId: "p-build" }, // Duplicate catalogue ID.
            ],
        },
        {
            agentId: "max",
            name: "Max",
            chats: [
                { id: 200, title: "Research Chat", projectId: "p-research" },
                { id: 201, title: "Another identity", projectId: "p-build" },
            ],
        },
    ];
    const member = (id: number, item: string, parentChatId?: number): Row => ({
        id,
        title: `Execution ${id}`,
        projectId: "p-build",
        workItemId: item,
        activeThreadId: id % 2 === 0 ? id : id + 1,
        groupingParentChatId: parentChatId,
        supervisor: { conversationId: id + 1_000, parentChatId },
        updatedAt: id,
    });
    const rows = workItemRows([
        { ...member(1, "alpha", 100), title: "Investigate alpha" },
        { ...member(2, "alpha", 100), title: "Review alpha" },
        member(3, "beta", 101),
        member(4, "beta", 101),
        member(5, "unknown", 999),
        member(6, "unknown", 999),
        member(7, "absent"),
        member(8, "absent"),
        member(9, "cross-project", 200),
        member(10, "cross-project", 200),
        {
            id: 11,
            title: "Linked only",
            projectId: "p-build",
            linkedFrom: { id: 100 },
            updatedAt: 0,
        },
        { ...member(12, "unassigned-own", 102), projectId: undefined },
        { ...member(13, "unassigned-reference", 100), projectId: undefined },
        { ...member(14, "unassigned-reference", 100), projectId: undefined },
        { id: 15, title: "Pinned unassigned Chat", updatedAt: 0 },
        member(16, "unassigned-parent", 102),
        { ...member(17, "closed-work", 103), archived: true },
        { ...member(18, "closed-work", 103), archived: true },
        { ...member(19, "closed-active-parent", 100), activeThreadId: 19, archived: true },
        { ...member(20, "removed-project", 104), projectId: "p-removed" },
        {
            ...member(21, "no-project-removed-parent", 104),
            activeThreadId: 21,
            projectId: undefined,
        },
        { ...member(22, "different-removed-project", 104), projectId: "p-also-removed" },
    ]);
    const filters = {
        archived: false,
        needle: "",
        pinned: [15],
        home: "/fixture/home",
        namedAgents,
    };
    const before = JSON.stringify({ rows, projects, namedAgents });
    const groups = projectGroups(rows, projects, filters);
    const build = groups[0];
    const research = groups[1];
    const flat = groups.at(-1);

    assert.ok(build);
    assert.ok(research);
    assert.ok(flat);
    assert.deepEqual(
        build.chats?.map((chat) => [chat.id, chat.rows.map((row) => row.id)]),
        [
            [100, [2]],
            [101, [4]],
            [201, []],
        ],
        "two Chats of one identity keep independent work; neither remit nor cross-project control duplicates a Chat",
    );
    assert.deepEqual(
        research.chats?.map((chat) => [chat.id, chat.rows.map((row) => row.id)]),
        [[200, []]],
        "the source Chat remains a leaf in its actual project when its work was explicitly placed elsewhere",
    );
    assert.equal(research.chats?.[0]?.projectId, "p-research");
    assert.deepEqual(
        flat.chats?.map((chat) => [chat.id, chat.rows.map((row) => row.id)]),
        [
            [102, [12]],
            [104, [20]],
        ],
        "unassigned and unavailable Chats remain reachable, but another actual project never becomes their child",
    );
    assert.equal(flat.chats?.find((chat) => chat.id === 102)?.contextLabel, "No project");
    assert.equal(flat.chats?.find((chat) => chat.id === 104)?.contextLabel, "Unavailable project");
    const chatIds = groups.flatMap((group) => group.chats?.map((chat) => chat.id) ?? []);

    assert.deepEqual(chatIds, [100, 101, 201, 200, 102, 104]);
    assert.equal(new Set(chatIds).size, chatIds.length, "duplicate saved IDs render only once");
    assert.equal(flat.rows[0]?.id, 15, "pins retain their native flat-section ordering");
    assert.equal(
        JSON.stringify({ rows, projects, namedAgents }),
        before,
        "grouping never moves stored Chat or work context",
    );
    const nested = new Set(build.chats?.flatMap((chat) => chat.rows.map((row) => row.id)));

    assert.deepEqual(
        build.rows.filter((row) => !nested.has(row.id)).map((row) => row.id),
        [16, 10, 8, 6, 11],
    );
    const buildChat = build.chats?.find((chat) => chat.id === 100);

    assert.ok(buildChat);
    assert.deepEqual(
        rowsInGroups(groups, (group) => group.key === buildChat.key).map((row) => row.id),
        [16, 10, 8, 6, 4, 11, 15, 22, 21, 20, 14, 12],
        "folding a Chat hides only its real co-located work, not cross-project or unassigned rows",
    );
    assert.equal(
        rowsInGroups(groups).length,
        rows.filter((row) => !row.archived).length,
        "each active Work Item remains in exactly one actual context",
    );
    assert.equal(
        new Set(rowsInGroups(groups).map((row) => row.id)).size,
        rows.filter((row) => !row.archived).length,
    );

    for (const [needle, expected] of [
        ["review alpha", [2]],
        ["first chat", [2]],
    ] as const) {
        const searched = projectGroups(rows, projects, { ...filters, needle });

        assert.ok(searched[0]);
        assert.deepEqual(
            searched[0].chats?.map((chat) => chat.id),
            [100],
        );
        assert.deepEqual(
            rowsInGroups(searched).map((row) => row.id),
            expected,
        );
    }

    const unassignedSearch = projectGroups(rows, projects, { ...filters, needle: "no project" });

    assert.deepEqual(
        unassignedSearch.at(-1)?.chats?.map((chat) => chat.id),
        [102],
    );
    assert.deepEqual(
        rowsInGroups(unassignedSearch).map((row) => row.id),
        [12],
    );
    const archived = projectGroups(rows, projects, { ...filters, archived: true });

    assert.deepEqual(
        archived.flatMap((group) =>
            group.chats?.map((chat) => [chat.id, chat.rows.map((row) => row.id)]),
        ),
        [[103, [18]]],
        "archive filtering does not invent a parent for archived work whose exact Chat is still active",
    );
    assert.deepEqual(
        rowsInGroups(archived).map((row) => row.id),
        [19, 18],
    );
    const rowSearch = projectGroups(rows, projects, { ...filters, needle: "execution 10" });

    assert.deepEqual(contents(rowSearch), [
        ["project:p-build", [10]],
        ["flat", []],
    ]);
    assert.deepEqual(rowSearch[0]?.chats, [], "search never synthesizes a cross-project Chat");
});

test("passive exact ownership survives stopped, completed, archived and inert-restored work independently of live control", () => {
    for (const lifecycle of ["stopped", "completed", "archived", "restored"]) {
        const archived = lifecycle === "archived";
        const namedAgents = [
            {
                agentId: "nora",
                name: "Nora",
                chats: [
                    { id: 100, title: "Owning Chat", projectId: "p-build", archived },
                    { id: 101, title: "Contact-only sibling", projectId: "p-build", archived },
                ],
            },
        ];
        const rows = workItemRows([
            {
                id: 1,
                title: lifecycle,
                workItemId: "owned",
                activeThreadId: 1,
                projectId: "p-build",
                updatedAt: 1,
                archived,
                groupingParentChatId: 100,
                supervisor: { conversationId: 200, status: "reclaimed" },
            },
            {
                id: 2,
                title: "Live or historical contact is not ownership",
                workItemId: "contact",
                activeThreadId: 2,
                projectId: "p-build",
                updatedAt: 2,
                archived,
                supervisor: { conversationId: 201, parentChatId: 101 },
            },
        ]);
        const groups = projectGroups(rows, projects, {
            archived,
            needle: "",
            pinned: [],
            home: "/fixture/home",
            namedAgents,
        });
        const build = groups.find((group) => group.key === "project:p-build")!;

        assert.deepEqual(
            build.chats?.map((chat) => [chat.id, chat.rows.map((row) => row.id)]),
            [
                [100, [1]],
                [101, []],
            ],
            lifecycle,
        );
        assert.deepEqual(
            rowsInGroups(groups).map((row) => row.id),
            [2, 1],
        );
        assert.deepEqual(
            rowsInGroups(groups, (group) => group.key === build.chats?.[0]?.key).map(
                (row) => row.id,
            ),
            [2],
        );
    }
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
