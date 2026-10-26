// The diff viewer: one file's diff (unified or side by side, with line numbers, syntax colors, the words that changed,
// and hidden lines a tap away), and Review, which walks every uncommitted change of a session's folder file by file.
// Parsing is web/diff-parse.js.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { jumpToEntry } from "./chat.js";
import { fingerprint, firstLine, hunkRows, markRanges, parseDiff } from "./diff-parse.js";
import { highlight, highlightLines, langOf } from "./highlight.js";
import { ReviewsPanel, ReviewThreads, useReviewRange } from "./reviews.js";
import { branchAvailable } from "./sheets/branch.js";
import { actions, api, attempt, canSteer, notify, openSheet, store } from "./store.js";
import { html, Icon, Loader, openFile, shortPath } from "./ui.js";

// ─── Preferences ────────────────────────────────────────────────────────────────────

const PREFS_KEY = "pocket.diff";
/** Side by side from this width of the viewer, when the layout is left to the app. */
const SPLIT_FROM = 880;

function readPrefs() {
    try {
        return { layout: "auto", wrap: true, ...JSON.parse(localStorage.getItem(PREFS_KEY)) };
    } catch {
        return { layout: "auto", wrap: true };
    }
}

let diffPrefs = readPrefs();

/** How diffs show on this device: `layout` is auto, split, or unified; `wrap` breaks long lines instead of scrolling. */
function setDiffPrefs(patch) {
    diffPrefs = { ...diffPrefs, ...patch };
    localStorage.setItem(PREFS_KEY, JSON.stringify(diffPrefs));
    store.set({});
}

/** The width of an element, kept current as it resizes. */
export function useWidth(ref) {
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const element = ref.current;

        if (!element) {
            return;
        }

        setWidth(element.clientWidth);
        const observer = new ResizeObserver(([entry]) =>
            setWidth(Math.round(entry.contentRect.width)),
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    return width;
}

/** Split or unified, for a viewer this wide. */
const layoutFor = (width) =>
    diffPrefs.layout === "auto" ? (width >= SPLIT_FROM ? "split" : "unified") : diffPrefs.layout;

/** The layout after `layout`, as the layout button and `s` step through them. */
const nextLayout = (layout) => ({ auto: "split", split: "unified", unified: "auto" })[layout];

// ─── One file ──────────────────────────────────────────────────────────────────────

/** A change's kind as one letter, as git status writes it; `new` is a file git does not track yet. */
export const KIND_LETTERS = { modified: "M", added: "A", deleted: "D", renamed: "R", new: "N" };
/** A file with more changed lines than this waits for a tap before it draws. */
const BIG_DIFF = 1200;
/** Hidden lines shown per tap on a long gap. */
const EXPAND_STEP = 20;
const NO_THREADS = [];

/** The highlighted HTML of each line of a file's hunks, by line object: each side of a hunk colored as one run. */
function highlightHunks(file, lang) {
    const out = new Map();

    for (const hunk of file.hunks) {
        for (const side of ["old", "new"]) {
            const lines = hunk.lines.filter(
                (line) => line.type === "ctx" || line.type === (side === "old" ? "del" : "add"),
            );
            const colored = highlightLines(
                lines.map((line) => line.text),
                lang,
            );

            lines.forEach((line, index) => {
                if (side === "new" || line.type === "del") {
                    out.set(line, colored[index]);
                }
            });
        }
    }

    return out;
}

/** The words that changed on each line, by line object. */
function wordMarks(rows) {
    const marks = new Map();

    for (const row of rows) {
        if (row.words) {
            marks.set(row.left, row.words.left);
            marks.set(row.right, row.words.right);
        }
    }

    return marks;
}

/** Files' lines as they are now, per conversation, path, and diff: null until read, false when they cannot be. */
const fileTexts = new Map();
/** How many files' lines are kept: the oldest go first. */
const FILE_TEXTS = 40;

/**
 * A file's lines in the folder now, for the lines a diff leaves out: read once per path while its diff stays the same.
 * null until read, and false when the file cannot give them (not text, or too big to read whole).
 */
function useFileText(path, key, wanted, reviewPath = null) {
    const conversationId = store.state.conversationId;
    const readPath = reviewPath ?? path;
    const id = [
        conversationId,
        reviewPath === null ? "file" : "review",
        reviewCwd(),
        readPath,
        key,
    ].join("\u0000");
    const [, setRead] = useState(0);

    useEffect(() => {
        if (!wanted || !readPath || fileTexts.has(id)) {
            return;
        }

        const controller = new AbortController();
        let live = true;

        const keep = (lines) => {
            if (!live) {
                return;
            }

            if (fileTexts.size >= FILE_TEXTS) {
                fileTexts.delete(fileTexts.keys().next().value);
            }

            fileTexts.set(id, lines);
            setRead((count) => count + 1);
        };

        // Review context is a bounded, complete-text read of this changed file, not generic Files access.
        // Other diff consumers keep the usual file reader, but cut-short text cannot reveal omitted lines.
        const read =
            reviewPath !== null
                ? actions
                      .reviewContext(conversationId, reviewPath, { signal: controller.signal })
                      .then((file) => file.text)
                : actions
                      .view(path, { signal: controller.signal })
                      .then((file) =>
                          file.kind === "text" && !file.truncated ? file.text : false,
                      );

        read.then(
            (text) =>
                keep(
                    typeof text === "string"
                        ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
                        : false,
                ),
            () => keep(false),
        );

        return () => {
            live = false;
            controller.abort();
        };
    }, [wanted, id]);

    return fileTexts.get(id) ?? null;
}

/** Hidden lines a gap has shown so far: `top` from the hunk above, `bottom` toward the hunk below. */
function gapLines(gap, shown, text) {
    const top = [];
    const bottom = [];
    const total = gap.to - gap.from + 1;
    const fromTop = Math.min(shown?.top ?? 0, total);
    const fromBottom = Math.min(shown?.bottom ?? 0, total - fromTop);

    const line = (number) => ({
        type: "ctx",
        text: text?.[number - 1] ?? "",
        old: number - gap.shift,
        new: number,
    });

    for (let number = gap.from; number < gap.from + fromTop; number++) {
        top.push(line(number));
    }

    for (let number = gap.to - fromBottom + 1; number <= gap.to; number++) {
        bottom.push(line(number));
    }

    return { top, bottom, left: total - fromTop - fromBottom };
}

/**
 * A diff that is a whole file, with nothing around it: a new or deleted one. By its kind, not its hunk: `-U0` writes an
 * insertion at the top of a file as `@@ -0,0 +1 @@` too.
 */
const wholeFile = (file) => file.kind === "added" || file.kind === "new" || file.kind === "deleted";

/** Unchanged lines a review's diff shows around each change (`src/server/changes.ts` asks git for that many). */
const CONTEXT = 3;

/**
 * Where a file ends, when its diff says: its last hunk shows fewer unchanged lines after its last change than a diff
 * shows around one, or a note that the file has no newline at its end.
 */
function endOf(file) {
    const lines = file.hunks.at(-1).lines;
    const changed = lines.findLastIndex((line) => line.type === "add" || line.type === "del");
    const after = lines.slice(changed + 1);

    return after.some((line) => line.type === "note") ||
        after.filter((line) => line.type === "ctx").length < CONTEXT
        ? file.hunks.at(-1).newEnd
        : undefined;
}

/** The unchanged runs between hunks, in new-file line numbers, with how far old numbers are behind there. */
function gapsOf(file, length) {
    const gaps = [];
    let next = 1;
    let shift = 0;

    for (const hunk of file.hunks) {
        const start = firstLine(hunk.newStart, hunk.newCount);

        shift = start - firstLine(hunk.oldStart, hunk.oldCount);
        gaps.push({ from: next, to: start - 1, shift });
        next = hunk.newEnd + 1;
        shift = hunk.newEnd - hunk.oldEnd;
    }

    // After the last hunk, as far as the file goes, once that is known.
    gaps.push({ from: next, to: length ?? next - 1, shift, open: length === undefined });

    return gaps;
}

/** Captured line numbers, inclusive. Keep malformed stored anchors bounded and outdated. */
function capturedLines(anchor) {
    const start = anchor?.startLine ?? anchor?.line;
    const end = anchor?.line;

    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        start > end ||
        end - start >= 100 ||
        typeof anchor.context !== "string" ||
        anchor.context.length > (anchor.startLine == null ? 1000 : 8000)
    ) {
        return [];
    }

    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/** A line-number cell. New-side numbers open the file at that line, when there is a file to open. */
function LineNo({ line, side, onLine, onComment, gutter, kind = "" }) {
    const number = side === "old" ? line?.old : line?.new;
    const comment = onComment && number !== undefined;
    const go = !comment && side === "new" && onLine && line?.new !== undefined;
    const selected = gutter?.selected(side, number) ?? false;
    const reviewed = gutter?.reviewed(side, number) ?? false;
    const anchor = { side, line: number, context: line?.text.slice(0, 1000) };

    return html`<td
        class=${`dv-n ${line ? kind : "none"} ${go ? "go" : ""} ${comment ? "commentable" : ""} ${selected ? "dv-selected" : ""} ${reviewed ? "dv-reviewed" : ""}`}
        data-n=${comment ? "" : (number ?? "")}
        onClick=${go ? () => onLine(line.new) : undefined}
    >
        ${
            comment &&
            html`<button
                type="button"
                class="dv-comment-line"
                data-n=${number}
                data-review-side=${side}
                data-no-swipe
                aria-label=${`Comment on ${side} line ${number}`}
                title=${`Comment on ${side} line ${number} · drag or Shift-click for a range`}
                aria-pressed=${selected}
                disabled=${gutter?.pending}
                onPointerDown=${(event) => gutter?.down(event, anchor)}
                onPointerEnter=${(event) => gutter?.enter(event, anchor)}
                onPointerUp=${(event) => gutter?.up(event)}
                onPointerCancel=${(event) => gutter?.cancel(event)}
                onTouchStart=${(event) => gutter?.touchStart(event, anchor)}
                onTouchMove=${(event) => gutter?.touchMove(event)}
                onTouchEnd=${(event) => gutter?.touchEnd(event)}
                onTouchCancel=${(event) => gutter?.touchCancel(event)}
                onContextMenu=${(event) => gutter?.contextMenu(event)}
                onClick=${(event) => onComment(anchor, event)}
            ></button>`
        }
    </td>`;
}

/** The two number cells of a unified row. */
const Numbers = ({ left, right, onLine, onComment, gutter, kind = "" }) =>
    html`<${LineNo}
        line=${left}
        side="old"
        onLine=${onLine}
        onComment=${onComment}
        gutter=${gutter}
        kind=${kind}
    /><${LineNo}
        line=${right}
        side="new"
        onLine=${onLine}
        onComment=${onComment}
        gutter=${gutter}
        kind=${kind}
    />`;

/** One line's code cell: its sign, its colors, and the words that changed. */
function Code({ line, colored, marks, kind, selected = false, reviewed = false }) {
    const source = colored.get(line);
    const body = markRanges(source ?? escapeText(line?.text ?? ""), marks.get(line));

    return html`<td
        class=${`dv-code ${kind} ${selected ? "dv-selected" : ""} ${reviewed ? "dv-reviewed" : ""}`}
        data-sign=${kind === "add" ? "+" : kind === "del" ? "−" : ""}
        dangerouslySetInnerHTML=${{ __html: body }}
    ></td>`;
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeText = (text) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The rows of one hunk, unified: unchanged lines, then each run of removed lines before the lines that replaced it. */
function UnifiedRows({ rows, colored, marks, onLine, onComment, gutter, afterLine }) {
    const out = [];

    for (let at = 0; at < rows.length; at++) {
        const row = rows[at];

        if (row.kind === "note") {
            out.push(html`<tr class="dv-note">
                <td colspan="3"><span>${row.left.text}</span></td>
            </tr>`);
            continue;
        }

        if (row.kind !== "change") {
            out.push(html`<tr class="dv-row">
                <${Numbers}
                    left=${row.left}
                    right=${row.right}
                    onLine=${onLine}
                    onComment=${onComment}
                    gutter=${gutter}
                />
                <${Code}
                    line=${row.left}
                    colored=${colored}
                    marks=${marks}
                    kind="ctx"
                    selected=${gutter?.selected("old", row.left?.old) || gutter?.selected("new", row.right?.new)}
                    reviewed=${gutter?.reviewed("old", row.left?.old) || gutter?.reviewed("new", row.right?.new)}
                />
            </tr>`);
            out.push(afterLine?.(row.left, row.right, 3));
            continue;
        }

        // A run of paired rows: every removed line first, then every added one.
        let end = at;

        while (rows[end + 1]?.kind === "change") {
            end++;
        }

        const run = rows.slice(at, end + 1);

        for (const each of run) {
            if (each.left) {
                out.push(html`<tr class="dv-row del">
                    <${Numbers}
                        left=${each.left}
                        right=${null}
                        onLine=${onLine}
                        onComment=${onComment}
                        gutter=${gutter}
                        kind="del"
                    />
                    <${Code}
                        line=${each.left}
                        colored=${colored}
                        marks=${marks}
                        kind="del"
                        selected=${gutter?.selected("old", each.left.old)}
                        reviewed=${gutter?.reviewed("old", each.left.old)}
                    />
                </tr>`);
                out.push(afterLine?.(each.left, null, 3));
            }
        }

        for (const each of run) {
            if (each.right) {
                out.push(html`<tr class="dv-row add">
                    <${Numbers}
                        left=${null}
                        right=${each.right}
                        onLine=${onLine}
                        onComment=${onComment}
                        gutter=${gutter}
                        kind="add"
                    />
                    <${Code}
                        line=${each.right}
                        colored=${colored}
                        marks=${marks}
                        kind="add"
                        selected=${gutter?.selected("new", each.right.new)}
                        reviewed=${gutter?.reviewed("new", each.right.new)}
                    />
                </tr>`);
                out.push(afterLine?.(null, each.right, 3));
            }
        }

        at = end;
    }

    return out;
}

/** The rows of one hunk side by side: old on the left, new on the right, changed lines paired across. */
function SplitRows({ rows, colored, marks, onLine, onComment, gutter, afterLine }) {
    return rows.map((row) => {
        if (row.kind === "note") {
            return html`<tr class="dv-note">
                <td colspan="4"><span>${row.left.text}</span></td>
            </tr>`;
        }

        const change = row.kind === "change";
        const { left, right } = row;

        return html`<tr class=${`dv-row ${change ? "change" : ""}`}>
            <${LineNo}
                line=${left}
                side="old"
                onLine=${onLine}
                onComment=${onComment}
                gutter=${gutter}
                kind=${change ? "del" : ""}
            />
            ${
                left
                    ? html`<${Code}
                          line=${left}
                          colored=${colored}
                          marks=${marks}
                          kind=${change ? "del" : "ctx"}
                          selected=${gutter?.selected("old", left.old)}
                          reviewed=${gutter?.reviewed("old", left.old)}
                      />`
                    : html`<td class="dv-code none"></td>`
            }
            <${LineNo}
                line=${right}
                side="new"
                onLine=${onLine}
                onComment=${onComment}
                gutter=${gutter}
                kind=${change ? "add" : ""}
            />
            ${
                right
                    ? html`<${Code}
                          line=${right}
                          colored=${colored}
                          marks=${marks}
                          kind=${change ? "add" : "ctx"}
                          selected=${gutter?.selected("new", right.new)}
                          reviewed=${gutter?.reviewed("new", right.new)}
                      />`
                    : html`<td class="dv-code none"></td>`
            }
        </tr>${afterLine?.(left, right, 4)}`;
    });
}

/** A run of hidden lines: how many, and buttons to show them, a step at a time from either end, or all at once. */
function GapRow({ left, columns, onShow, first, last }) {
    if (left <= 0) {
        return null;
    }

    const all = left <= EXPAND_STEP * 1.5;

    return html`<tr class="dv-gap">
        <td colspan=${columns}>
            ${
                all
                    ? html`<button type="button" onClick=${() => onShow("all")}>
                          ${first ? "↑" : last ? "↓" : "↕"} Show ${left} hidden ${left === 1 ? "line" : "lines"}
                      </button>`
                    : html`${
                          !first &&
                          html`<button
                              type="button"
                              title="Show more below the hunk above"
                              onClick=${() => onShow("top")}
                          >
                              ↓ ${EXPAND_STEP}
                          </button>`
                      }
                      <button type="button" onClick=${() => onShow("all")}>
                          Show all ${left} hidden lines
                      </button>
                      ${
                          !last &&
                          html`<button
                              type="button"
                              title="Show more above the hunk below"
                              onClick=${() => onShow("bottom")}
                          >
                              ↑ ${EXPAND_STEP}
                          </button>`
                      }`
            }
        </td>
    </tr>`;
}

/**
 * One file's diff. `path` opens the file at a line; optional `reviewPath` reads omitted context through scoped review
 * access instead of generic Files (`expand`, read again whenever `version` changes). `head` draws its header bar,
 * with `tools` (buttons) at its end. `open` and `onToggle` fold it; `loading` says its lines are on their way,
 * `error` that they did not come. Colors, pairs, and rows are worked out only for a diff that is drawn, and the table
 * is made again only when what it shows changes.
 */
function DiffFile({
    file,
    path = "",
    reviewPath = null,
    version = "",
    expand = false,
    head = true,
    tools = null,
    viewed = null,
    onViewed = null,
    open = true,
    onToggle = null,
    note = null,
    loading = false,
    error = null,
    onComment = null,
    discussion = null,
}) {
    const ref = useRef(null);
    const width = useWidth(ref);
    const split = layoutFor(width) === "split";
    const anchor = discussion?.anchor;
    const selection = useReviewRange(file.path, anchor);
    const [preview, setPreview] = useState(null);
    const drag = useRef(null);
    const skipClick = useRef(false);
    const pointer = useRef("");

    const cancelDrag = (event) => {
        const current = drag.current;

        if (
            event?.pointerId != null &&
            (current?.touch || event.pointerId !== current?.pointerId)
        ) {
            return;
        }

        if (current) {
            current.cleanup();
            skipClick.current = true;
        }

        drag.current = null;
        setPreview(null);
    };

    const updateDrag = (current, number) => {
        // Drag previews are bounded; Shift-click still reports an excessive range in the composer.
        const end = Math.max(1, Math.min(current.start + 99, Math.max(current.start - 99, number)));

        if (current.end !== end || !current.previewed) {
            current.end = end;
            current.previewed = true;
            setPreview({
                side: current.side,
                start: Math.min(current.start, end),
                end: Math.max(current.start, end),
            });
        }
    };

    const finishDrag = (event) => {
        const current = drag.current;

        if (!current || current.touch || current.pointerId !== event.pointerId) {
            return;
        }

        current.cleanup();
        drag.current = null;
        setPreview(null);
        skipClick.current = true;
        current.commit(current.end);
    };

    const beginDrag = (event, next, touch = null) => {
        cancelDrag();
        skipClick.current = false;
        const origin = event.shiftKey && anchor?.side === next.side ? anchor : next;
        const current = {
            pointerId: event.pointerId,
            touch,
            side: next.side,
            start: origin.line,
            end: next.line,
            selecting: !touch,
            timer: null,
            commit: (end) => {
                if (end !== origin.line || event.shiftKey) {
                    selection.select(origin, origin.line, end);
                }

                onComment(origin);
            },
        };

        const otherTouch = (event) => {
            if (event.touches.length > 1) {
                cancelDrag();
            }
        };

        const hidden = () => document.hidden && cancelDrag();

        // Only a live gesture owns global listeners, not every file in a large review.
        // Mouse release outside the gutter settles the last valid endpoint. Touch events stay
        // on their initial button; hit testing below follows the held contact instead of enter.
        document.addEventListener("pointerup", finishDrag);
        document.addEventListener("pointercancel", cancelDrag);
        document.addEventListener("touchstart", otherTouch, { passive: true });
        document.addEventListener("visibilitychange", hidden);
        globalThis.addEventListener("blur", cancelDrag);
        globalThis.addEventListener("pagehide", cancelDrag);

        current.cleanup = () => {
            clearTimeout(current.timer);
            document.removeEventListener("pointerup", finishDrag);
            document.removeEventListener("pointercancel", cancelDrag);
            document.removeEventListener("touchstart", otherTouch);
            document.removeEventListener("visibilitychange", hidden);
            globalThis.removeEventListener("blur", cancelDrag);
            globalThis.removeEventListener("pagehide", cancelDrag);
        };

        drag.current = current;

        if (touch) {
            current.timer = setTimeout(() => {
                if (drag.current === current) {
                    current.selecting = true;
                    updateDrag(current, current.end);
                }
            }, 450);
        } else {
            updateDrag(current, current.end);
        }
    };

    const touchHit = (current, contact) => {
        const button = document
            .elementFromPoint(contact.clientX, contact.clientY)
            ?.closest(".dv-comment-line");
        const number = Number(button?.dataset.n);

        if (
            ref.current?.contains(button) &&
            button.dataset.reviewSide === current.side &&
            Number.isSafeInteger(number) &&
            number > 0
        ) {
            updateDrag(current, number);
        }
    };

    useEffect(() => {
        cancelDrag();

        return () => cancelDrag();
    }, [file, open, Boolean(onComment)]);

    const selectLine = (next, event = {}) => {
        if (skipClick.current && event.detail !== 0) {
            skipClick.current = false;

            return;
        }

        if (selection.pending) {
            return;
        }

        const touch =
            event.pointerType === "touch" ||
            (!event.pointerType && event.detail !== 0 && pointer.current === "touch");
        const extend = anchor?.line && anchor.side === next.side && (event.shiftKey || touch);

        if (extend) {
            selection.select(anchor, anchor.line, next.line);
        }

        onComment(extend ? anchor : next);
    };

    const shownSelection = preview ?? selection;
    const reviewedLines = new Set();
    const gutter = {
        pending: selection.pending,
        reviewed: (side, number) => reviewedLines.has(`${side}:${number}`),
        selected: (side, number) =>
            number !== undefined &&
            side === shownSelection.side &&
            number >= shownSelection.start &&
            number <= shownSelection.end,
        down: (event, next) => {
            pointer.current = event.pointerType;
            skipClick.current = false;

            // Touch needs cancellable touchmove after hold intent: changing touch-action during
            // pointerdown cannot take a native pan back from Safari. Ordinary motion stays native.
            if (
                event.pointerType === "touch" ||
                event.button > 0 ||
                event.isPrimary === false ||
                selection.pending
            ) {
                return;
            }

            event.preventDefault();
            beginDrag(event, next);
        },
        enter: (event, next) => {
            const current = drag.current;

            if (
                current &&
                !current.touch &&
                current.pointerId === event.pointerId &&
                current.side === next.side
            ) {
                updateDrag(current, next.line);
            }
        },
        up: finishDrag,
        cancel: cancelDrag,
        touchStart: (event, next) => {
            pointer.current = "touch";

            if (event.touches.length !== 1 || selection.pending) {
                cancelDrag();

                return;
            }

            const contact = event.changedTouches[0];

            beginDrag(event, next, {
                identifier: contact.identifier,
                clientX: contact.clientX,
                clientY: contact.clientY,
            });
        },
        touchMove: (event) => {
            const current = drag.current;
            const contact = Array.from(event.touches).find(
                (touch) => touch.identifier === current?.touch?.identifier,
            );

            if (!current?.touch || !contact) {
                return;
            }

            if (
                event.touches.length !== 1 ||
                (!current.selecting &&
                    Math.hypot(
                        contact.clientX - current.touch.clientX,
                        contact.clientY - current.touch.clientY,
                    ) > 10)
            ) {
                cancelDrag();

                return;
            }

            if (current.selecting) {
                if (!event.cancelable) {
                    cancelDrag();

                    return;
                }

                // Local to the starting gutter button, and only after a deliberate stationary hold.
                event.preventDefault();
                touchHit(current, contact);
            }
        },
        touchEnd: (event) => {
            const current = drag.current;
            const contact = Array.from(event.changedTouches).find(
                (touch) => touch.identifier === current?.touch?.identifier,
            );

            if (!current?.touch || !contact) {
                return;
            }

            // Some engines report the last displacement only at release.
            if (
                !current.selecting &&
                Math.hypot(
                    contact.clientX - current.touch.clientX,
                    contact.clientY - current.touch.clientY,
                ) > 10
            ) {
                cancelDrag();

                return;
            }

            current.cleanup();
            drag.current = null;
            setPreview(null);

            if (current.selecting) {
                touchHit(current, contact);
                setPreview(null);
                skipClick.current = true;

                if (event.cancelable) {
                    event.preventDefault();
                }

                current.commit(current.end);
            }
        },
        touchCancel: (event) => {
            const current = drag.current;

            if (
                Array.from(event.changedTouches).some(
                    (touch) => touch.identifier === current?.touch?.identifier,
                )
            ) {
                cancelDrag();
            }
        },
        contextMenu: (event) => {
            if (drag.current?.touch) {
                event.preventDefault();
            }
        },
    };

    // The file header may be stuck above a scrolled diff. Its new composer lives at the file's
    // natural start, so reveal the mounted form rather than leaving it offscreen above that header.
    useLayoutEffect(() => {
        if (!discussion?.anchor || discussion.anchor.line || !open) {
            return;
        }

        const host = ref.current;
        const form = host?.querySelector(":scope > .rv-threads > .rv-form");

        if (!form) {
            return;
        }

        const index = host.closest(".dr")?.querySelector(".dr-review-index");
        const header = host.querySelector(".dv-head");
        const margin =
            (index?.getBoundingClientRect().height ?? 0) +
            (header?.getBoundingClientRect().height ?? 0) +
            8;

        form.style.scrollMarginTop = `${margin}px`;
        form.scrollIntoView({ block: "start", behavior: "instant" });
    }, [discussion?.anchor, open]);
    const lang = langOf(file.path);
    const size = file.added + file.removed;
    const [force, setForce] = useState(false);
    const [shown, setShown] = useState({});
    const drawn =
        open &&
        !loading &&
        !file.binary &&
        file.hunks.length > 0 &&
        (size <= BIG_DIFF || force || discussion?.threads.length > 0 || discussion?.target);
    const colored = useMemo(
        () => (drawn ? highlightHunks(file, lang) : new Map()),
        [drawn, file, lang],
    );
    const rowsByHunk = useMemo(() => (drawn ? file.hunks.map(hunkRows) : []), [drawn, file]);
    const marks = useMemo(() => wordMarks(rowsByHunk.flat()), [rowsByHunk]);

    // Another version of the diff has other gaps: what was shown of the old ones does not apply.
    useEffect(() => setShown({}), [file]);
    // A diff cut short cannot say where its last hunk ends, so the lines after it are not known either.
    const canExpand =
        expand &&
        Boolean(reviewPath ?? path) &&
        file.hunks.length > 0 &&
        !wholeFile(file) &&
        !file.truncated;
    const asked = Object.values(shown).some((each) => each.top + each.bottom > 0);
    const hunkLines = useMemo(() => {
        const lines = new Map();

        for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
                if (line.type !== "note") {
                    for (const side of ["old", "new"]) {
                        if (line[side] !== undefined) {
                            lines.set(`${side}:${line[side]}`, line);
                        }
                    }
                }
            }
        }

        return lines;
    }, [file]);
    const needsContext =
        open &&
        canExpand &&
        discussion?.threads.some(
            (thread) =>
                thread.cwd === discussion.cwd &&
                capturedLines(thread).some((number) => !hunkLines.has(`${thread.side}:${number}`)),
        );
    const fetched = useFileText(
        path,
        version || `${file.added}:${file.removed}`,
        canExpand && (asked || needsContext || Boolean(discussion?.anchor?.line)),
        reviewPath,
    );
    // The file as it is now must still read as the diff says, or its other lines would be shown in the wrong places.
    const matches = useMemo(
        () =>
            fetched === null ||
            (fetched !== false &&
                file.hunks.every((hunk) =>
                    hunk.lines.every(
                        (line) =>
                            line.type === "del" ||
                            line.type === "note" ||
                            fetched[line.new - 1] === line.text,
                    ),
                )),
        [fetched, file],
    );
    const text = matches && fetched !== null ? fetched : null;
    const expandable = canExpand && matches;
    const gaps = useMemo(
        () => (expandable ? gapsOf(file, text?.length ?? endOf(file)) : []),
        [file, expandable, text?.length],
    );

    const lineAt = (side, lineNumber) => {
        const line = hunkLines.get(`${side}:${lineNumber}`);

        if (line) {
            return { line, gap: -1 };
        }

        if (!text || !expandable) {
            return null;
        }

        for (let index = 0; index < gaps.length; index++) {
            const gap = gaps[index];
            const number = side === "old" ? lineNumber + gap.shift : lineNumber;

            if (number >= gap.from && number <= gap.to && text[number - 1] !== undefined) {
                return {
                    line: {
                        type: "ctx",
                        old: number - gap.shift,
                        new: number,
                        text: text[number - 1],
                    },
                    gap: index,
                };
            }
        }

        return null;
    };

    // Human range selection is confined to this file and its initially chosen side. Reuse
    // the same complete-file evidence and old/new gap mapping as stored range placement.
    const rangeEvidence = (start, end) => {
        const locations = Array.from({ length: end - start + 1 }, (_, index) =>
            lineAt(discussion.anchor.side, start + index),
        );

        if (locations.some((location) => !location)) {
            return {
                error:
                    canExpand && fetched === null
                        ? "Reading complete range context…"
                        : "Complete range context is unavailable. Choose lines shown in this diff or refresh Changes.",
            };
        }

        const context = locations.map((location) => location.line.text).join("\n");

        return start !== end && context.length > 8000
            ? { error: "Choose a smaller range." }
            : { context };
    };

    // A range belongs at its original end only when ALL captured lines still match, not just
    // the end line. Unlike legacy single-line anchors, range evidence is never truncated.
    const locate = (anchor) => {
        const numbers = capturedLines(anchor);

        if (!numbers.length) {
            return null;
        }

        const locations = numbers.map((number) => lineAt(anchor.side, number));

        if (locations.some((location) => !location)) {
            return null;
        }

        const context =
            anchor.startLine == null
                ? locations[0].line.text.slice(0, 1000)
                : locations.map((location) => location.line.text).join("\n");

        return context === anchor.context ? locations.at(-1) : null;
    };

    const capturedContext = new Map();
    const inlineThreads = new Map();
    const outdated = [];
    const fileThreads = [];
    const waitingForContext = needsContext && fetched === null;

    for (const thread of discussion?.threads ?? []) {
        if (thread.cwd !== discussion.cwd) {
            outdated.push(thread);
        } else if (!thread.line) {
            fileThreads.push(thread);
        } else {
            const location = locate(thread);

            if (location) {
                for (const number of capturedLines(thread)) {
                    reviewedLines.add(`${thread.side}:${number}`);
                    const captured = lineAt(thread.side, number);

                    if (captured.gap !== -1) {
                        capturedContext.set(captured.line.new, captured);
                    }
                }

                const key = `${thread.side}:${thread.line}`;
                const group = inlineThreads.get(key) ?? [];

                group.push(thread);
                inlineThreads.set(key, group);
            } else if (!loading && !waitingForContext) {
                outdated.push(thread);
            }
        }
    }

    const anchorLocation = locate(anchor);
    const afterLine = discussion
        ? (left, right, columns) =>
              [
                  ["old", left],
                  ["new", right],
              ].map(([side, line]) => {
                  const number = line?.[side];

                  if (number === undefined) {
                      return null;
                  }

                  const threads = inlineThreads.get(`${side}:${number}`) ?? [];
                  const composing =
                      anchorLocation && anchor?.side === side && anchor.line === number;

                  if (threads.length === 0 && !composing) {
                      return null;
                  }

                  return html`<tr class="dv-review-row" key=${`${side}:${number}`}>
                      <td colspan=${columns}>
                          <${ReviewThreads}
                              path=${file.path}
                              side=${side}
                              line=${number}
                              context=${anchor?.context ?? ""}
                              rangeEvidence=${rangeEvidence}
                              threads=${[]}
                              composing=${Boolean(composing)}
                              onCancel=${discussion.onCancel}
                          />
                          <${ReviewThreads}
                              path=${file.path}
                              side=${side}
                              line=${number}
                              context=${line.text.slice(0, 1000)}
                              threads=${threads}
                          />
                      </td>
                  </tr>`;
              })
        : null;
    const headerThreads =
        discussion &&
        html`
        <${ReviewThreads}
            key="file-composer"
            path=${file.path}
            threads=${[]}
            composing=${Boolean(anchor && !anchor.line)}
            onCancel=${discussion.onCancel}
        />
        <${ReviewThreads} key="file" path=${file.path} threads=${fileThreads} />
        ${outdated.map(
            (thread) => html`<${ReviewThreads}
            key=${thread.id}
            path=${file.path}
            side=${thread.side ?? null}
            line=${thread.line ?? null}
            context=${thread.context ?? ""}
            threads=${[thread]}
            outdated=${true}
        />`,
        )}
        ${
            !loading &&
            !waitingForContext &&
            anchor?.line &&
            !anchorLocation &&
            html`<${ReviewThreads}
            key="outdated-composer"
            path=${file.path}
            side=${anchor.side}
            line=${anchor.line}
            context=${anchor.context}
            rangeEvidence=${rangeEvidence}
            threads=${[]}
            composing=${true}
            outdated=${true}
            onCancel=${discussion.onCancel}
        />`
        }
    `;

    const table = useMemo(() => {
        if (!drawn) {
            return null;
        }

        const columns = split ? 4 : 3;
        const Rows = split ? SplitRows : UnifiedRows;
        const onLine = path ? (line) => openFile(`${path}:${line}`) : null;
        const none = new Map();

        const show = (index, how) =>
            setShown((all) => {
                const gap = gaps[index];
                const before = all[index] ?? { top: 0, bottom: 0 };

                const next =
                    how === "all"
                        ? { top: gap.to - gap.from + 1, bottom: 0 }
                        : how === "top"
                          ? { ...before, top: before.top + EXPAND_STEP }
                          : { ...before, bottom: before.bottom + EXPAND_STEP };

                return { ...all, [index]: next };
            });

        /** Context rows for lines a gap shows, colored as one run. */
        const contextRows = (lines) => {
            if (!lines.length) {
                return null;
            }

            const colors = highlightLines(
                lines.map((line) => line.text),
                lang,
            );
            const extra = new Map(lines.map((line, index) => [line, colors[index]]));

            return html`<${Rows}
                rows=${lines.map((line) => ({ kind: "ctx", left: line, right: line }))}
                colored=${extra}
                marks=${none}
                onLine=${onLine}
                onComment=${onComment ? selectLine : null}
                gutter=${gutter}
                afterLine=${afterLine}
            />`;
        };

        const gapRows = (index) => {
            const gap = gaps[index];

            if (!gap) {
                return null;
            }

            const wanted = (shown[index]?.top ?? 0) + (shown[index]?.bottom ?? 0) > 0;

            if (text === null && wanted) {
                return html`<tr class="dv-gap">
                    <td colspan=${columns}><span class="dv-reading">Reading the file…</span></td>
                </tr>`;
            }

            // Where the file ends is not known until it is read: offer to show what follows the last hunk.
            if (gap.open) {
                return html`<tr class="dv-gap">
                    <td colspan=${columns}>
                        <button type="button" onClick=${() => show(index, "top")}>↓ Show more</button>
                    </td>
                </tr>`;
            }

            const { top, bottom } = gapLines(gap, shown[index], text);
            const from = gap.from + top.length;
            const to = gap.to - bottom.length;
            // Reveal commented context without drawing thousands of unrelated hidden lines.
            const extra = new Map();

            for (const location of [...capturedContext.values(), anchorLocation]) {
                if (
                    location?.gap === index &&
                    location.line.new >= from &&
                    location.line.new <= to
                ) {
                    extra.set(location.line.new, location.line);
                }
            }

            let next = from;
            const middle = [];
            const hidden = (start, end) => html`<${GapRow}
                left=${end - start + 1}
                columns=${columns}
                first=${index === 0}
                last=${index === gaps.length - 1}
                onShow=${(how) => show(index, how)}
            />`;

            // Color adjacent captured lines as one run, preserving multiline syntax state
            // and avoiding one highlighter invocation (and empty gap) per range line.
            let run = [];

            for (const [number, line] of [...extra].sort(([a], [b]) => a - b)) {
                if (number !== next) {
                    middle.push(contextRows(run), hidden(next, number - 1));
                    run = [];
                }

                run.push(line);
                next = number + 1;
            }

            middle.push(contextRows(run), hidden(next, to));

            return html`${contextRows(top)}${middle}${contextRows(bottom)}`;
        };

        /** Hidden lines still hidden before hunk `index`: none once a gap is shown whole, so its header goes too. */
        const hiddenBefore = (index) =>
            gaps[index] ? gapLines(gaps[index], shown[index], text).left : 0;

        return html`<table class=${`dv-table ${split ? "split" : "unified"}`}>
            ${
                split
                    ? html`<colgroup>
                          <col class="dv-col-n" />
                          <col />
                          <col class="dv-col-n" />
                          <col />
                      </colgroup>`
                    : html`<colgroup>
                          <col class="dv-col-n" />
                          <col class="dv-col-n" />
                          <col />
                      </colgroup>`
            }
            ${file.hunks.map(
                (hunk, index) => html`<tbody key=${index}>
                    ${expandable && gapRows(index)}
                    ${
                        !wholeFile(file) &&
                        (!expandable || (hunk.context && hiddenBefore(index) > 0)) &&
                        html`<tr class="dv-hunk">
                            <td colspan=${columns}>
                                <span class="dv-at">${`@@ −${hunk.oldStart} +${hunk.newStart} @@`}</span>
                                ${hunk.context && html`<span class="dv-context">${hunk.context}</span>`}
                            </td>
                        </tr>`
                    }
                    <${Rows}
                        rows=${rowsByHunk[index]}
                        colored=${colored}
                        marks=${marks}
                        onLine=${onLine}
                        onComment=${onComment ? selectLine : null}
                        gutter=${gutter}
                        afterLine=${afterLine}
                    />
                </tbody>`,
            )}
            ${expandable && html`<tbody>${gapRows(gaps.length - 1)}</tbody>`}
        </table>`;
    }, [
        drawn,
        split,
        file,
        colored,
        rowsByHunk,
        marks,
        gaps,
        shown,
        text,
        expandable,
        path,
        lang,
        onComment,
        discussion,
        selection,
        preview,
        // Cached VNodes also contain discussion controls. Keep their live permissions,
        // people and capabilities fresh without rebuilding on every streamed entry.
        store.state.me,
        store.state.users,
        store.state.server,
        store.state.view.turns,
        Boolean(store.state.view.live?.busy),
        (store.state.view.subagents ?? []).some((agent) => agent.busy),
    ]);

    let body;

    // A failure shows folded too: a folded file that could not be read must not look like one that could.
    if (error) {
        body = html`<p class="dv-empty err">${error}</p>`;
    } else if (loading) {
        body = html`<div class="dv-wait"><${Loader} label="Reading the diff" /></div>`;
    } else if (file.binary) {
        body = html`<p class="dv-empty">A binary file: no lines to compare.</p>`;
    } else if (file.hunks.length === 0) {
        body = html`<p class="dv-empty">
            ${file.kind === "renamed" ? "Renamed, with no change to its text." : file.mode ? "Only its mode changed." : "No difference in text."}
        </p>`;
    } else if (!drawn) {
        body = html`<p class="dv-empty">
            ${`A large diff: ${size.toLocaleString()} changed lines. `}
            <button class="link" type="button" onClick=${() => setForce(true)}>Show it</button>
        </p>`;
    } else {
        body = html`<div class="dv-scroll">
            ${table}
            ${
                file.truncated &&
                html`<p class="dv-empty small">
                    ${"The diff is too long to show whole: the rest is left out."}
                </p>`
            }
            ${
                canExpand &&
                !matches &&
                html`<p class="dv-empty small">
                    ${fetched === false ? "This file is too big to show its other lines here." : "The file changed after this diff was read, so its other lines cannot be shown. Refresh to see them."}
                </p>`
            }
        </div>`;
    }

    return html`<section
        class=${`dv ${diffPrefs.wrap ? "wrap" : ""} ${open ? "" : "folded"} ${viewed ? "viewed" : ""}`}
        ref=${ref}
        data-review-ready=${!loading && !waitingForContext ? "true" : "false"}
    >
        ${head && html`<${FileHead} file=${file} tools=${tools} viewed=${viewed} onViewed=${onViewed} open=${open} onToggle=${onToggle} note=${note} />`}
        ${open && headerThreads}
        ${open ? body : error && html`<p class="dv-empty err">${error}</p>`}
    </section>`;
}

/** The path as a folder and a name, the name brighter: what changed is easier to find at the end of a long path. */
function PathLabel({ path }) {
    const at = path.lastIndexOf("/");

    return html`<span class="dv-path" title=${path}>
        ${at >= 0 && html`<span class="dv-dir">${path.slice(0, at + 1)}</span>`}
        <span class="dv-name">${path.slice(at + 1)}</span>
    </span>`;
}

/** Lines added and removed, as +12 −3. */
function ChangeCounts({ added, removed }) {
    return html`<span class="dv-counts">
        ${added > 0 && html`<span class="ok">+${added}</span>`}
        ${removed > 0 && html`<span class="err">−${removed}</span>`}
    </span>`;
}

/** A file's header bar: fold, what kind of change, its path, the counts, and Viewed. */
function FileHead({ file, tools, viewed, onViewed, open, onToggle, note }) {
    const kind = file.kind;
    const title =
        kind === "renamed" && file.oldPath && file.oldPath !== file.path
            ? html`<span class="dv-dir dv-was">${file.oldPath} →</span><${PathLabel} path=${file.path} />`
            : html`<${PathLabel} path=${file.path} />`;

    return html`<header class="dv-head" style="top:var(--review-index-height,0px)">
        ${
            onToggle &&
            html`<button
                class="dv-fold"
                type="button"
                aria-expanded=${open ? "true" : "false"}
                aria-label=${open ? "Fold" : "Unfold"}
                onClick=${onToggle}
            >
                <${Icon} name="chevron" size=${14} class=${`chev ${open ? "open" : ""}`} />
            </button>`
        }
        <span class=${`change-kind ${kind}`} title=${kind}>${KIND_LETTERS[kind] ?? "M"}</span>
        ${
            onToggle
                ? html`<button class="dv-title" type="button" onClick=${onToggle}>${title}</button>`
                : html`<span class="dv-title">${title}</span>`
        }
        ${note}
        <${ChangeCounts} added=${file.added} removed=${file.removed} />
        ${tools}
        ${
            onViewed &&
            html`<label class=${`dv-viewed ${viewed ? "on" : ""}`} title="Mark as viewed (v)">
                <input
                    type="checkbox"
                    aria-label="Viewed"
                    checked=${Boolean(viewed)}
                    onChange=${(event) => onViewed(event.currentTarget.checked)}
                />
                <span>Viewed</span>
            </label>`
        }
    </header>`;
}

/** Diff text from a tool call or a reply: each file it holds, with a header unless `bare` (the call names the file). */
export function DiffBlock({ text, path = "", bare = false }) {
    const parsed = useMemo(() => parseDiff(text, path), [text, path]);
    const files = parsed.files.filter((file) => file.hunks.length > 0 || file.binary);

    // Lines without numbered hunks (as in a diff written by hand) are colored as a diff, not drawn as one.
    if (files.length === 0) {
        return html`<pre class="diff" dangerouslySetInnerHTML=${{ __html: highlight(text, "diff") }}></pre>`;
    }

    return html`<div class="dv-block" data-part="diff">
        ${files.map(
            (file) => html`<${DiffFile}
                file=${file}
                path=${bare && canSteer() ? path : ""}
                head=${!bare}
            />`,
        )}
    </div>`;
}

// ─── Settings bar ────────────────────────────────────────────────────────────────────

const LAYOUTS = [
    ["auto", "Auto"],
    ["unified", "Unified"],
    ["split", "Split"],
];

/** Auto, unified, or split: the same on every diff of this device (`s` steps through them). */
function LayoutSwitch() {
    return html`<div class="dr-layout" role="group" aria-label="Diff layout" title="Layout (s)">
        ${LAYOUTS.map(
            ([layout, label]) => html`<button
                type="button"
                class=${diffPrefs.layout === layout ? "on" : ""}
                aria-pressed=${diffPrefs.layout === layout ? "true" : "false"}
                onClick=${() => setDiffPrefs({ layout })}
            >
                ${label}
            </button>`,
        )}
    </div>`;
}

/** Wrapping long lines instead of scrolling them, the same on every diff of this device (`w`). */
function WrapToggle() {
    const { wrap } = diffPrefs;

    return html`<button
        type="button"
        class=${`chip toggle ${wrap ? "on" : ""}`}
        title="Wrap long lines (w)"
        aria-pressed=${wrap ? "true" : "false"}
        onClick=${() => setDiffPrefs({ wrap: !wrap })}
    >
        Wrap
    </button>`;
}

// ─── Review: every change in the folder ───────────────────────────────────────────────

const VIEWED_KEY = "pocket.viewed";

function readViewed(id) {
    try {
        return JSON.parse(localStorage.getItem(`${VIEWED_KEY}.${id}`)) ?? {};
    } catch {
        return {};
    }
}

function writeViewed(id, viewed) {
    localStorage.setItem(`${VIEWED_KEY}.${id}`, JSON.stringify(viewed));
}

/** How long after the conversation moves on the changes are read again: soon when quiet, less often while Pi works. */
const QUIET_WAIT = 1200;
const BUSY_WAIT = 4000;
/** While Pi works, the longest the changes go without being read again. */
const BUSY_MAX = 8000;

/** One answer, request and refresh lifecycle for all readers of this caller/conversation/folder. */
const changesCache = new Map();
const changesReaders = new Map();

const commentsEnabled = () => store.state.server?.localReviews >= 2;
const reviewCwd = () => store.state.view.agent?.cwd ?? store.state.view.conversation?.cwd ?? "";

const changesScope = () => {
    const user = store.state.me;

    return user ? JSON.stringify([user.id, user.role, user.sessions ?? null]) : null;
};

const changesKey = (id) =>
    `${id}\u0000${changesScope()}\u0000${commentsEnabled() ? "review" : "working"}\u0000${reviewCwd()}`;
const changesAllowed = () => Boolean(store.state.me) && (commentsEnabled() || canSteer());
let changesUser = changesScope();
let changesDeparted = false;
let changesWatch = null;
let changesTimer = null;
const changesAwake = () => !changesDeparted && !document.hidden && navigator.onLine !== false;

function stopChangesRead(known) {
    known.controller?.abort();
    known.controller = null;
    known.pending = null;
}

function clearChangesTimer() {
    clearTimeout(changesTimer);
    changesTimer = null;
}

/** Ask again for the current scoped Changes. Explicit Refresh bypasses freshness, not page/access fences. */
export function reloadChanges(id = store.state.conversationId) {
    if (id === null || id !== store.state.conversationId || !changesAllowed() || !changesAwake()) {
        return Promise.resolve();
    }

    const key = changesKey(id);
    const known = changesCache.get(key) ?? { data: null, error: null, pending: null };

    if (known.pending) {
        return known.pending;
    }

    const controller = new AbortController();
    const entry = store.state.view.order?.at(-1);
    const busy = Boolean(store.state.view.live?.busy);
    const current = () =>
        !controller.signal.aborted &&
        changesCache.get(key) === known &&
        id === store.state.conversationId &&
        key === changesKey(id) &&
        changesAllowed();

    known.controller = controller;
    changesCache.set(key, known);
    known.pending = api(`c/${id}/${commentsEnabled() ? "reviews/changes" : "changes"}`, undefined, {
        signal: controller.signal,
    })
        .then(
            (data) => {
                if (current()) {
                    Object.assign(known, { data, error: null });
                }
            },
            (failure) => {
                if (current()) {
                    known.error = failure.message;
                }
            },
        )
        .finally(() => {
            if (current()) {
                Object.assign(known, {
                    pending: null,
                    controller: null,
                    at: Date.now(),
                    entry,
                    busy,
                });
                store.set({});
            }
        });
    clearChangesTimer();

    return known.pending;
}

/** Store and page events update one debounce, independent of how many UI surfaces show Changes. */
function syncChanges() {
    const scope = changesScope();
    const id = store.state.conversationId;
    const key = changesKey(id);
    const awake = changesAwake() && id !== null && changesAllowed();

    if (scope !== changesUser) {
        changesUser = scope;

        for (const known of changesCache.values()) {
            stopChangesRead(known);
        }

        changesCache.clear();
    }

    for (const [cached, known] of changesCache) {
        if (!awake || cached !== key) {
            stopChangesRead(known);
        }
    }

    if (!awake || !changesReaders.has(key)) {
        clearChangesTimer();
        changesWatch = null;

        return;
    }

    const entry = store.state.view.order?.at(-1);
    const busy = Boolean(store.state.view.live?.busy);

    if (changesWatch?.key !== key) {
        changesWatch = { key, entry, busy };
        // A new active conversation or foreground return checks external edits once, not once per consumer.
        reloadChanges(id);

        return;
    }

    if (entry !== changesWatch.entry || busy !== changesWatch.busy) {
        clearChangesTimer();
        Object.assign(changesWatch, { entry, busy });
    }

    const known = changesCache.get(key);

    if (known?.pending || (known?.entry === entry && known?.busy === busy)) {
        clearChangesTimer();

        return;
    }

    if (changesTimer === null) {
        // Moving entries debounce together, with a maximum wait while Pi keeps working. No idle polling.
        const since = Date.now() - (known?.at ?? Date.now());
        const wait = busy ? Math.max(0, Math.min(BUSY_WAIT, BUSY_MAX - since)) : QUIET_WAIT;

        changesTimer = setTimeout(() => {
            changesTimer = null;
            reloadChanges(id);
        }, wait);
    }
}

store.subscribe(syncChanges);
document.addEventListener("visibilitychange", syncChanges);
addEventListener("online", syncChanges);
addEventListener("offline", syncChanges);
addEventListener("pagehide", () => {
    changesDeparted = true;
    syncChanges();
});
addEventListener("pageshow", () => {
    changesDeparted = false;
    syncChanges();
});

/**
 * What changed in this conversation's folder, shared by the header, Files and Changes. `live` registers interest;
 * the first active reader owns no special timer or forced read. Hidden/offline/departed pages suspend the shared
 * lifecycle; returning checks once. Caller, folder and review/working namespaces never share answers.
 */
export function useChanges(live = true) {
    const id = store.state.conversationId;
    const key = changesKey(id);
    const allowed = changesAllowed();
    const known = allowed ? changesCache.get(key) : null;

    useEffect(() => {
        if (!live || !allowed || id === null) {
            return;
        }

        changesReaders.set(key, (changesReaders.get(key) ?? 0) + 1);
        syncChanges();

        return () => {
            const readers = changesReaders.get(key) - 1;

            if (readers > 0) {
                changesReaders.set(key, readers);
            } else {
                changesReaders.delete(key);
                const known = changesCache.get(key);

                if (known) {
                    stopChangesRead(known);
                }
            }

            syncChanges();
        };
    }, [key, live, allowed]);

    return { changes: known?.data ?? null, error: known?.error ?? null };
}

/** Diffs fetched per conversation and file, until the file changes (its version, from the server). */
const diffCache = new Map();
/** How many diffs are kept: the oldest go first. */
const DIFF_CACHE = 200;
/** Refreshes per conversation: each one makes every diff's key new, so diffs on screen are read again too. */
const refreshes = new Map();

/**
 * What a diff depends on: the file (its version, and its counts), the commit it is against, and the last Refresh. Any
 * of them changing reads the diff again.
 */
const diffKey = (id, file, base) =>
    [
        id,
        commentsEnabled() ? "review" : "working",
        reviewCwd(),
        file.path,
        file.kind,
        file.discussionOnly ? "comments" : "diff",
        file.version ?? "",
        `${file.added}:${file.removed}`,
        base ?? "",
        refreshes.get(id) ?? 0,
    ].join("\u0000");

function keepDiff(key, made) {
    if (diffCache.size >= DIFF_CACHE) {
        diffCache.delete(diffCache.keys().next().value);
    }

    diffCache.set(key, made);
}

/** Forget a conversation's diffs and files, so Refresh reads every one again, those on screen included. */
function forgetDiffs(id) {
    refreshes.set(id, (refreshes.get(id) ?? 0) + 1);

    for (const cache of [diffCache, fileTexts]) {
        for (const key of cache.keys()) {
            if (key.startsWith(`${id}\u0000`)) {
                cache.delete(key);
            }
        }
    }
}

/** Fetches of diffs at once: a folder of 300 changed files asks for them a few at a time. */
const DIFF_FETCHES = 4;
let fetching = 0;
const waiting = [];

function fetchDiff(id, path, signal, review = commentsEnabled()) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);

            return;
        }

        const cancel = () => {
            const index = waiting.indexOf(run);

            if (index !== -1) {
                waiting.splice(index, 1);
            }

            reject(signal.reason);
        };

        const run = async () => {
            fetching++;

            try {
                if (review) {
                    const result = await actions.reviewDiff(id, path, { signal });

                    resolve(result.diff);

                    return;
                }

                if (!canSteer()) {
                    throw new Error("This server does not support review reads yet.");
                }

                const response = await fetch(
                    `/api/c/${id}/changes/diff?path=${encodeURIComponent(path)}`,
                    { signal },
                );
                const text = await response.text();

                if (!response.ok) {
                    let failure;

                    try {
                        failure = JSON.parse(text).error;
                    } catch {
                        // Not the server's answer (a proxy's page, say): the status says enough.
                    }

                    throw new Error(failure ?? `HTTP ${response.status}`);
                }

                resolve(text);
            } catch (error) {
                reject(error);
            } finally {
                signal.removeEventListener("abort", cancel);
                fetching--;
                waiting.shift()?.();
            }
        };

        signal.addEventListener("abort", cancel, { once: true });

        if (fetching < DIFF_FETCHES) {
            run();
        } else {
            waiting.push(run);
        }
    });
}

/** Paths in the order the tree shows them: at each level, folders before files, each by name. */
function treeOrder(a, b) {
    const left = a.path.split("/");
    const right = b.path.split("/");

    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const leftDir = index < left.length - 1;
        const rightDir = index < right.length - 1;

        if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
        }

        if (left[index] !== right[index]) {
            return left[index].localeCompare(right[index]);
        }
    }

    return left.length - right.length;
}

/** The folders and files of a list of changed paths, as a tree whose single-child folders are joined: `src/server/`. */
function treeOf(files) {
    const root = { name: "", dirs: new Map(), files: [] };

    for (const file of files) {
        const parts = file.path.split("/");
        let node = root;

        for (const part of parts.slice(0, -1)) {
            if (!node.dirs.has(part)) {
                node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
            }

            node = node.dirs.get(part);
        }

        node.files.push(file);
    }

    const join = (node) => {
        for (const [key, child] of node.dirs) {
            let each = child;

            while (each.files.length === 0 && each.dirs.size === 1) {
                const [only] = each.dirs.values();

                each = { ...only, name: `${each.name}/${only.name}` };
            }

            node.dirs.set(key, each);
            join(each);
        }
    };

    join(root);

    return root;
}

/** A folder of the review's tree, which folds on its own. */
function TreeDir({ dir, depth, current, viewed, onPick }) {
    const [open, setOpen] = useState(true);

    return html`<div class="dr-dir">
        <button
            type="button"
            class="dr-row dir"
            style=${`--depth:${depth}`}
            aria-expanded=${open ? "true" : "false"}
            onClick=${() => setOpen(!open)}
        >
            <${Icon} name="chevron" size=${11} class=${`chev ${open ? "open" : ""}`} />
            <span class="dr-name">${dir.name}</span>
        </button>
        ${
            open &&
            html`<${TreeNode}
                node=${dir}
                depth=${depth + 1}
                current=${current}
                viewed=${viewed}
                onPick=${onPick}
            />`
        }
    </div>`;
}

function TreeNode({ node, depth, current, viewed, onPick }) {
    return html`${[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
            (dir) => html`<${TreeDir}
                key=${dir.name}
                dir=${dir}
                depth=${depth}
                current=${current}
                viewed=${viewed}
                onPick=${onPick}
            />`,
        )}
    ${node.files.map(
        (file) => html`<button
            type="button"
            key=${file.path}
            class=${`dr-row file ${current === file.path ? "on" : ""} ${viewed(file) ? "seen" : ""}`}
            aria-current=${current === file.path ? "true" : undefined}
            style=${`--depth:${depth}`}
            title=${file.path}
            onClick=${() => onPick(file.path)}
        >
            <span class=${`change-kind ${file.kind}`}>${KIND_LETTERS[file.kind]}</span>
            <span class="dr-name">${file.path.split("/").pop()}</span>
            ${
                file.byPi &&
                html`<span
                class="dr-pi"
                role="img"
                aria-label="Pi edited it"
                title="Pi edited it"
            ><span class="tava-mark" aria-hidden="true"></span></span>`
            }
            <span class="dr-tail">${viewed(file) ? html`<${Icon} name="check" size=${13} />` : html`<${ChangeCounts} added=${file.added ?? 0} removed=${file.removed ?? 0} />`}</span>
        </button>`,
    )}`;
}

/** One file of the review: fetches its diff once it nears the screen, then draws it. */
function ReviewFile({
    id,
    file,
    active,
    root,
    base,
    open,
    viewedAs,
    onToggle,
    onViewed,
    onLoaded,
    onChanged,
    onOpen,
    threads = [],
    target = null,
    commenting = false,
}) {
    const ref = useRef(null);
    const key = diffKey(id, file, base);
    const [loaded, setEntry] = useState(() => diffCache.get(key) ?? null);
    const entry = loaded?.key === key ? loaded : null;
    const [error, setError] = useState(null);
    const [near, setNear] = useState(false);
    const [undoing, setUndoing] = useState(false);
    const [anchor, setAnchor] = useState(null);

    useEffect(() => {
        const element = ref.current;

        if (!element || near) {
            return;
        }

        const observer = new IntersectionObserver(
            (seen) => seen.some((each) => each.isIntersecting) && setNear(true),
            { rootMargin: "900px 0px" },
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [near]);

    useEffect(() => {
        if (!active) {
            return;
        }

        const cached = diffCache.get(key);

        if (cached) {
            setEntry(cached);
            onLoaded(file.path, cached.print);

            return;
        }

        if (file.discussionOnly) {
            setEntry({ key, parsed: null, print: "" });

            return;
        }

        if (!near && !target) {
            return;
        }

        const controller = new AbortController();
        let live = true;

        setEntry(null);
        setError(null);
        fetchDiff(id, file.path, controller.signal).then(
            (text) => {
                if (!live) {
                    return;
                }

                const parsed = parseDiff(text, file.path).files[0] ?? null;
                const made = { key, parsed, print: fingerprint(text) };

                keepDiff(key, made);
                setEntry(made);
                onLoaded(file.path, made.print);
            },
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
            controller.abort();
        };
    }, [key, near, Boolean(target), active]);

    // The same object while nothing changed: the diff's colors and rows are worked out once per version.
    const shown = useMemo(
        () =>
            entry?.parsed
                ? { ...entry.parsed, kind: file.kind, path: file.path }
                : { ...file, hunks: [], added: file.added ?? 0, removed: file.removed ?? 0 },
        [entry, key],
    );
    const viewed = viewedAs !== undefined && (!entry || viewedAs === entry.print);
    const stale = viewedAs !== undefined && entry && viewedAs !== entry.print;

    // Undoing a file that is new since the last commit deletes it: the buttons say so.
    const fresh = file.kind === "new" || file.kind === "added";

    // The first tap asks; a second within a few seconds undoes.
    useEffect(() => {
        if (!undoing) {
            return;
        }

        const timer = setTimeout(() => setUndoing(false), 4000);

        return () => clearTimeout(timer);
    }, [undoing]);

    const undo = () =>
        undoing
            ? attempt(async () => {
                  await actions.revert(file.path);
                  notify(
                      "info",
                      fresh
                          ? `Deleted ${file.path}.`
                          : `${file.path} is as the last commit has it.`,
                  );
                  onChanged();
              })
            : setUndoing(true);

    const comment = useMemo(
        () => (next) => {
            onOpen(file.path);
            setAnchor(next);
        },
        [onOpen, file.path],
    );
    const cwd = file.discussionOnly ? null : reviewCwd();
    const discussion = useMemo(
        () =>
            commenting ? { threads, cwd, anchor, target, onCancel: () => setAnchor(null) } : null,
        [commenting, threads, cwd, anchor, target],
    );

    const tools = html`${
        commenting &&
        !file.discussionOnly &&
        html`<button
        class="icon-button dv-tool"
        type="button"
        title="Comment on file"
        aria-label=${`Comment on ${file.path}`}
        onClick=${() => comment({})}
    >
        <${Icon} name="chat" size=${15} />
    </button>`
    }${
        !file.discussionOnly &&
        canSteer() &&
        file.kind !== "deleted" &&
        html`<button
            class="icon-button dv-tool"
            type="button"
            title="Open the file"
            aria-label="Open the file"
            onClick=${() => openFile(`${root}/${file.path}`)}
        >
            <${Icon} name="file" size=${16} />
        </button>`
    }
    ${
        !file.discussionOnly &&
        canSteer() &&
        file.kind !== "renamed" &&
        html`<button
            class=${`icon-button dv-tool ${undoing ? "danger" : ""}`}
            type="button"
            title=${undoing ? (fresh ? "Tap again to delete this new file" : "Tap again to throw these changes away") : fresh ? "Delete this new file" : "Undo the changes to this file"}
            aria-label="Undo changes"
            onClick=${undo}
        >
            ${undoing ? (fresh ? "Delete?" : "Undo?") : html`<${Icon} name="undo" size=${16} />`}
        </button>`
    }`;

    return html`<div
        class="dr-file"
        ref=${ref}
        data-path=${file.path}
        style="scroll-margin-top:calc(var(--review-index-height,0px) + .3rem)"
    >
        <${DiffFile}
            file=${shown}
            path=${file.discussionOnly || !canSteer() ? "" : `${root}/${file.path}`}
            reviewPath=${commenting && !file.discussionOnly ? file.path : null}
            version=${key}
            loading=${!entry && !error}
            error=${error}
            expand=${active && !file.discussionOnly && (commenting || canSteer())}
            onComment=${active && commenting && !file.discussionOnly ? comment : null}
            discussion=${discussion}
            tools=${tools}
            viewed=${viewed}
            onViewed=${(on) => onViewed(file.path, on ? (entry?.print ?? "?") : undefined)}
            open=${open && !viewed}
            onToggle=${() => onToggle(file.path, viewed)}
            note=${html`${file.byPi && html`<span class="chip dv-chip">Pi</span>`}${file.discussionOnly && html`<span class="chip dv-chip">outdated</span>`}${stale && html`<span class="chip dv-chip warn" title="It changed after you marked it viewed">changed</span>`}`}
        />
    </div>`;
}

/**
 * Review: every uncommitted change in the session's folder, as a tree of files beside their diffs (or above them, when
 * narrow). Files fold, mark as viewed (kept per device until the file's diff changes), and fetch their diffs as they
 * near the screen. Keys: j and k go to the next and previous file, n and p to the next and previous hunk, v marks the
 * file at the top as viewed, s switches the layout, w wrapping.
 */
export function DiffReview({ active = true, autoFocus = false, covering = false }) {
    const id = store.state.conversationId;
    const { server } = store.state;
    const commenting = commentsEnabled();
    const allowed = commenting || canSteer();
    const { changes: workingChanges, error } = useChanges(active && allowed);
    const changes = allowed ? workingChanges : null;
    const threads = commenting ? (store.state.view.reviews?.threads ?? NO_THREADS) : NO_THREADS;
    const threadsByPath = useMemo(() => {
        const grouped = new Map();

        for (const thread of threads) {
            const group = grouped.get(thread.path) ?? [];

            group.push(thread);
            grouped.set(thread.path, group);
        }

        return grouped;
    }, [threads]);
    const cwd = reviewCwd();
    const viewId = commenting ? `${id}@${cwd}` : id;
    const target =
        store.state.reviewTarget?.conversationId === id ? store.state.reviewTarget : null;
    const targetThread = threads.find((thread) => thread.id === target?.threadId);
    const load = useMemo(() => () => reloadChanges(id), [id]);

    const refresh = () => {
        forgetDiffs(id);
        load();
    };

    const [viewed, setViewedState] = useState(() => readViewed(viewId));
    const [folded, setFolded] = useState({});
    const [filter, setFilter] = useState("");
    const [onlyPi, setOnlyPi] = useState(false);
    const [current, setCurrent] = useState(null);
    const [treeOpen, setTreeOpen] = useState(false);
    const [composingGeneral, setComposingGeneral] = useState(false);
    const prints = useRef({});
    const ref = useRef(null);
    const indexRef = useRef(null);
    const width = useWidth(ref);
    const wide = width >= 720;

    useLayoutEffect(() => {
        const index = indexRef.current;
        const host = ref.current;

        if (!index || !host) {
            return;
        }

        const measure = () =>
            host.style.setProperty(
                "--review-index-height",
                `${index.getBoundingClientRect().height}px`,
            );
        const observer = new ResizeObserver(measure);

        measure();
        observer.observe(index);

        return () => observer.disconnect();
    }, [id, commenting]);

    // The tree of changed files over the diffs, where they do not fit side by side, in a tile that covers the screen:
    // back folds it away.
    useBack(covering && active && treeOpen && width > 0 && !wide, () => setTreeOpen(false));

    const wasActive = useRef(active);

    useEffect(() => {
        setViewedState(readViewed(viewId));
        setFolded({});
        setCurrent(null);
        setFilter("");
        setOnlyPi(false);
        setTreeOpen(false);
        setComposingGeneral(false);
        prints.current = {};
    }, [viewId]);
    // Keys reach the review when someone asks for it (its tab picked, the tile opened on it, the sheet), away from touch
    // screens: not on a reload, nor on a phone, where it would only move the page.
    const ask = store.state.filesAsk;
    const focus = () =>
        !matchMedia("(pointer: coarse)").matches && ref.current?.focus({ preventScroll: true });

    useEffect(() => {
        if (active && !wasActive.current) {
            focus();
        }

        wasActive.current = active;
    }, [active]);
    useEffect(() => {
        if (active && (autoFocus || (ask?.tab === "changes" && Date.now() - ask.at < 1500))) {
            focus();
        }
    }, [ask, changes !== null]);

    /** Mark a file viewed as of the diff `print` names, or not viewed (undefined), kept for this device. */
    const setViewed = useMemo(
        () => (path, print) =>
            setViewedState((before) => {
                const next = { ...before };

                if (print === undefined) {
                    delete next[path];
                } else {
                    next[path] = print;
                }

                writeViewed(viewId, next);

                return next;
            }),
        [viewId],
    );
    const openReviewFile = useMemo(
        () => (path) => {
            setViewed(path, undefined);
            setFolded((each) => ({ ...each, [path]: false }));
        },
        [setViewed],
    );
    const toggleReviewFile = useMemo(
        () => (path, marked) => {
            if (marked) {
                openReviewFile(path);
            } else {
                setFolded((each) => ({ ...each, [path]: !each[path] }));
            }
        },
        [openReviewFile],
    );
    const loadedReviewFile = useMemo(
        () => (path, print) => {
            prints.current[path] = print;
            // Marked viewed before its diff arrived: as of this one.
            setViewedState((before) => {
                if (before[path] !== "?") {
                    return before;
                }

                const next = { ...before, [path]: print };

                writeViewed(viewId, next);

                return next;
            });
        },
        [viewId],
    );

    // Marks of files that are no longer changed (committed, or put back) go: they would never be seen again.
    useEffect(() => {
        if (!changes?.repo || changes.more > 0) {
            return;
        }

        const listed = new Set(changes.files.map((file) => file.path));

        setViewedState((before) => {
            const kept = Object.fromEntries(
                Object.entries(before).filter(([path]) => listed.has(path)),
            );

            if (Object.keys(kept).length === Object.keys(before).length) {
                return before;
            }

            writeViewed(viewId, kept);

            return kept;
        });
    }, [changes]);

    // Committed, reverted, renamed or out-of-scope paths keep their conversations visible.
    const all = [...(changes?.files ?? [])];
    const paths = new Set(all.map((file) => file.path));

    for (const thread of threads) {
        if (thread.path && !paths.has(thread.path)) {
            paths.add(thread.path);
            all.push({
                path: thread.path,
                kind: "modified",
                added: 0,
                removed: 0,
                discussionOnly: true,
            });
        }
    }

    const files = all
        .filter(
            (file) =>
                (!onlyPi || file.byPi) &&
                (filter === "" || file.path.toLowerCase().includes(filter.toLowerCase())),
        )
        .sort(treeOrder);

    const isViewed = (file) => {
        const mark = viewed[file.path];

        return mark !== undefined && (prints.current[file.path] ?? mark) === mark;
    };

    const seen = files.filter(isViewed).length;
    const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
    const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
    const tree = useMemo(() => treeOf(files), [changes, threads, filter, onlyPi]);
    const jumped = useRef(null);
    const jumpRequest = useRef(null);

    const jumpToThread = (thread, { reply = false } = {}) => {
        store.set({
            reviewTarget: {
                conversationId: id,
                threadId: thread.id,
                reply,
                n: (store.state.reviewTarget?.n ?? 0) + 1,
            },
        });
    };

    // Internal index rows and external receipt links share the complete exact-thread operation.
    // A cross-conversation link waits for the source room's committed thread before preparing it.
    useLayoutEffect(() => {
        if (!active || !targetThread || jumpRequest.current === target) {
            return;
        }

        jumpRequest.current = target;
        setFilter("");
        setOnlyPi(false);
        setTreeOpen(false);

        if (targetThread.path) {
            setViewed(targetThread.path, undefined);
            setFolded((before) => ({ ...before, [targetThread.path]: false }));
            setCurrent(targetThread.path);
        }
    }, [active, target, targetThread]);

    // Wait for actual renders, not a guessed delay: lazy diffs, hidden context and thread disclosure
    // all settle before the one scroll. The deadline only bounds a failed load and never triggers a scroll.
    useEffect(() => {
        if (
            !active ||
            !targetThread ||
            jumpRequest.current !== target ||
            !ref.current ||
            (!changes && !error)
        ) {
            return;
        }

        const token = `${id}:${target.threadId}:${target.n}`;

        if (jumped.current === token) {
            return;
        }

        let frame = 0;
        let done = false;
        const host = ref.current;
        const observer = new MutationObserver(() => schedule());

        const stop = () => {
            done = true;
            observer.disconnect();
            cancelAnimationFrame(frame);
            clearTimeout(deadline);
        };

        const check = () => {
            frame = 0;

            if (done) {
                return;
            }

            const element = host.querySelector(`#review-thread-${CSS.escape(target.threadId)}`);
            const file = element?.closest(".dv");
            const replyInput = target.reply ? element?.querySelector(".rv-form textarea") : null;

            if (
                !element ||
                (target.reply && !replyInput) ||
                (file && (file.dataset.reviewReady !== "true" || file.classList.contains("folded")))
            ) {
                return;
            }

            const index = host.querySelector(".dr-review-index");
            const margin =
                (index?.getBoundingClientRect().height ?? 0) +
                (file?.querySelector(".dv-head")?.getBoundingClientRect().height ?? 0) +
                16;

            element.style.scrollMarginTop = `${margin}px`;
            element.scrollIntoView({ block: "start", behavior: "instant" });
            (replyInput ?? element).focus({ preventScroll: true });
            jumped.current = token;
            stop();
        };

        const schedule = () => {
            if (!frame && !done) {
                frame = requestAnimationFrame(check);
            }
        };

        const deadline = setTimeout(() => {
            stop();
            notify("info", "The comment could not be located. Refresh Changes and try again.");
        }, 30000);

        observer.observe(host, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-review-ready", "aria-expanded"],
        });
        schedule();

        return stop;
    }, [active, id, target, Boolean(targetThread), Boolean(changes), error]);

    const scrollTo = (path) => {
        const element = ref.current?.querySelector(`.dr-file[data-path="${CSS.escape(path)}"]`);

        setCurrent(path);
        setViewed(path, undefined);
        setFolded((all) => ({ ...all, [path]: false }));

        if (!wide) {
            setTreeOpen(false);
        }

        requestAnimationFrame(() =>
            element?.scrollIntoView({ block: "start", behavior: "smooth" }),
        );
    };

    /** The file whose diff is at the top of the scroller now. */
    const atTop = () => {
        const scroller =
            ref.current?.closest(".files-body, .sheet-body") ?? document.scrollingElement;
        const top = scroller.getBoundingClientRect().top + 8;
        const sections = [...(ref.current?.querySelectorAll(".dr-file") ?? [])];

        return (
            sections.find((each) => each.getBoundingClientRect().bottom > top + 40) ?? sections[0]
        );
    };

    const onKey = (event) => {
        if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
        ) {
            return;
        }

        const sections = [...(ref.current?.querySelectorAll(".dr-file") ?? [])];
        // The file last gone to, while it is on screen; otherwise the one at the top. A smooth scroll still on its
        // way would otherwise make a second press go to the same file.
        const chosen = sections.find((each) => each.dataset.path === current);
        const box = chosen?.getBoundingClientRect();
        const here = box && box.bottom > 0 && box.top < innerHeight ? chosen : atTop();
        const index = sections.indexOf(here);
        const key = event.key;

        if (key === "j" || key === "k") {
            const next =
                sections[
                    Math.max(0, Math.min(sections.length - 1, index + (key === "j" ? 1 : -1)))
                ];

            if (next) {
                scrollTo(next.dataset.path);
            }
        } else if (key === "n" || key === "p") {
            // The first row of each run of changes, in either layout, and where a row lands when gone to: below the
            // file's header, by the rows' scroll margin.
            const changed = ".dv-row.add, .dv-row.del, .dv-row.change";
            const starts = [...ref.current.querySelectorAll(changed)].filter((row) => {
                let previous = row.previousElementSibling;

                while (previous?.matches(".dv-review-row")) {
                    previous = previous.previousElementSibling;
                }

                return !previous?.matches(changed);
            });
            const scroller = ref.current.closest(".files-body, .sheet-body");
            const margin = starts[0] ? parseFloat(getComputedStyle(starts[0]).scrollMarginTop) : 0;
            const reviewHeight = indexRef.current?.getBoundingClientRect().height ?? 0;
            const top = (scroller?.getBoundingClientRect().top ?? 0) + (margin || 0) + reviewHeight;
            const target =
                key === "n"
                    ? starts.find((row) => row.getBoundingClientRect().top > top + 2)
                    : starts.findLast((row) => row.getBoundingClientRect().top < top - 2);

            if (target) {
                target.style.scrollMarginTop = `${(margin || 0) + reviewHeight}px`;
                target.scrollIntoView({ block: "start", behavior: "smooth" });
                target.style.removeProperty("scroll-margin-top");
            }
        } else if (key === "v" && here) {
            const path = here.dataset.path;

            setViewed(path, isViewed({ path }) ? undefined : (prints.current[path] ?? "?"));
        } else if (key === "s") {
            const next = nextLayout(diffPrefs.layout);

            setDiffPrefs({ layout: next });
            notify("info", `Diffs: ${next}.`);
        } else if (key === "w") {
            setDiffPrefs({ wrap: !diffPrefs.wrap });
        } else {
            return;
        }

        event.preventDefault();
    };

    const reviewsPanel =
        commenting &&
        html`<div
        class="dr-review-index"
        ref=${indexRef}
        style="position:sticky;top:0;z-index:4;background:var(--bg)"
    >
        <${ReviewsPanel} key=${id} active=${active} onJump=${jumpToThread} />
    </div>`;
    const general =
        commenting &&
        html`<div class="dr-general">
        ${
            !composingGeneral &&
            html`<button
            type="button"
            class="button ghost small rv-button"
            aria-label="Comment on all changes"
            onClick=${() => setComposingGeneral(true)}
        >
            <${Icon} name="chat" size=${15} />
            Comment on all changes
        </button>`
        }
        <${ReviewThreads}
            key=${`${id}:general`}
            threads=${threads.filter((thread) => !thread.path)}
            composing=${composingGeneral}
            onCancel=${() => setComposingGeneral(false)}
        />
    </div>`;

    if (!changes && !error) {
        return html`<div class="dr" ref=${ref}>
            ${reviewsPanel}
            ${general}
            ${
                allowed
                    ? html`<${Loader} label="Asking git" />`
                    : html`<p class="dv-empty muted">This server does not support live review comments yet.</p>`
            }
        </div>`;
    }

    return html`<div class=${`dr ${wide ? "wide" : ""}`} ref=${ref} tabindex="-1" onKeyDown=${onKey}>
        ${reviewsPanel}
        ${general}
        ${error && html`<p class="dv-empty err" role="alert">${error}</p>`}
        <div class="dr-summary">
            ${
                changes?.repo
                    ? html`<span class="dr-where mono">
                          ${
                              changes.repo.root !== cwd &&
                              html`<span class="dr-path">${shortPath(changes.repo.root, server?.home)}</span>`
                          }${
                              changes.repo.branch &&
                              (canSteer() && branchAvailable()
                                  ? html`<button
                                        class="dr-branch"
                                        type="button"
                                        title="Switch or make a branch"
                                        onClick=${() => openSheet({ type: "branch" })}
                                    >
                                        <${Icon} name="fork" size=${12} />
                                        ${changes.repo.branch}
                                    </button>`
                                  : html`<span class="dr-branch" title="Branch">
                                        <${Icon} name="fork" size=${12} />
                                        ${changes.repo.branch}
                                    </span>`)
                          }
                      </span>`
                    : html`<span class="muted small">Not a git repository: only Pi's edits are listed.</span>`
            }
            ${
                all.length > 0 &&
                html`<span class="dr-stats">
                    <strong>${files.length} ${files.length === 1 ? "file" : "files"}</strong>
                    <${ChangeCounts} added=${added} removed=${removed} />
                </span>
                <span class="dr-viewed">${seen} of ${files.length} viewed</span>`
            }
            <span class="dr-actions">
                ${all.length > 0 && html`<${LayoutSwitch} />`}
                ${
                    allowed &&
                    html`<button
                        class="icon-button dv-tool"
                        type="button"
                        title="Look again"
                        aria-label="Refresh"
                        onClick=${refresh}
                    >
                        <${Icon} name="reload" size=${15} />
                    </button>`
                }
            </span>
        </div>
        ${
            all.length > 0 &&
            html`<div class="dr-tools">
                <input
                    class="dr-filter"
                    type="search"
                    placeholder="Filter files"
                    value=${filter}
                    onInput=${(event) => setFilter(event.currentTarget.value)}
                    autocapitalize="off"
                    autocomplete="off"
                    spellcheck="false"
                />
                ${
                    all.some((file) => file.byPi) &&
                    html`<button
                        type="button"
                        class=${`chip toggle ${onlyPi ? "on" : ""}`}
                        aria-pressed=${onlyPi ? "true" : "false"}
                        title="Only the files Pi edited"
                        onClick=${() => setOnlyPi(!onlyPi)}
                    >
                        <span class="tava-mark" aria-hidden="true"></span> Pi only
                    </button>`
                }
                <${WrapToggle} />
                ${
                    !wide &&
                    html`<button
                        type="button"
                        class=${`chip toggle ${treeOpen ? "on" : ""}`}
                        onClick=${() => setTreeOpen(!treeOpen)}
                    >
                        Files
                    </button>`
                }
            </div>`
        }
        ${
            changes?.repo &&
            changes.files.length === 0 &&
            html`<div class="dr-clean">
                <${Icon} name="check" size=${22} />
                <p>No uncommitted changes${changes.repo.branch ? ` on ${changes.repo.branch}` : ""}.</p>
            </div>`
        }
        ${
            all.length > 0 &&
            html`<div class="dr-main">
                ${
                    (wide || treeOpen) &&
                    html`<nav
                        class="dr-tree"
                        aria-label="Changed files"
                        style="top:var(--review-index-height,0px)"
                    >
                        <${TreeNode}
                            node=${tree}
                            depth=${0}
                            current=${current}
                            viewed=${isViewed}
                            onPick=${scrollTo}
                        />
                        ${files.length === 0 && html`<p class="muted small">No file matches.</p>`}
                    </nav>`
                }
                <div class="dr-files">
                    ${files.map(
                        (file) => html`<${ReviewFile}
                            key=${`${viewId}:${file.path}`}
                            id=${id}
                            active=${active}
                            file=${file}
                            root=${changes?.repo?.root ?? cwd}
                            base=${changes?.repo?.head}
                            commenting=${commenting}
                            threads=${threadsByPath.get(file.path) ?? NO_THREADS}
                            target=${targetThread?.path === file.path ? target : null}
                            onOpen=${openReviewFile}
                            open=${!folded[file.path]}
                            viewedAs=${viewed[file.path]}
                            onToggle=${toggleReviewFile}
                            onViewed=${setViewed}
                            onLoaded=${loadedReviewFile}
                            onChanged=${load}
                        />`,
                    )}
                    ${
                        changes?.more > 0 &&
                        html`<p class="muted small">
                            And ${changes.more} more changed ${changes.more === 1 ? "file" : "files"}, not listed here.
                        </p>`
                    }
                </div>
            </div>`
        }
        ${
            changes?.piOnly?.length > 0 &&
            html`<div class="dr-pionly">
                <div class="group-title">${changes.repo ? "Pi also edited (no uncommitted change)" : "Pi wrote or edited"}</div>
                ${changes.piOnly.map(
                    (
                        each,
                    ) => html`<button type="button" class="list-item" onClick=${() => jumpToEntry(each.entryId)}>
                        <span class="mono">${shortPath(each.path, server?.home)}</span>
                        <span class="muted small">show</span>
                    </button>`,
                )}
            </div>`
        }
    </div>`;
}
