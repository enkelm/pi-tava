// Real chat renderer, inert hooks and Markdown: no browser, sockets or production-only test seam.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { h } from "preact";

const htm = (await import(import.meta.resolve("htm"))).default;

test("private chat shows the complete ask and retries only an explicit immutable saved reply", async (t) => {
    const sends: unknown[][] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const fixture = {
        html: htm.bind(h),
        Icon: () => null,
        store: {
            state: { server: { agentProfiles: [{ id: "chat", name: "Chat", icon: "chat" }] } },
        },
        Markdown: ({ text }: { text: string }) => h("markdown", { text }),
        useState: () => [false, () => {}],
        useRef: () => ({ current: false }),
        actions: {
            retryPipAnswer: async (...args: unknown[]) => {
                sends.push(args);
                await pending;
            },
        },
        attempt: (run: () => Promise<unknown>) => run(),
    };
    const globals = globalThis as typeof globalThis & { pipChatUiFixture?: typeof fixture };

    globals.pipChatUiFixture = fixture;
    const mocks: Record<string, string> = {
        "preact/hooks": "export const {useRef,useState}=globalThis.pipChatUiFixture;",
        "./store.js": "export const {actions,attempt,store}=globalThis.pipChatUiFixture;",
        "./ui.js": "export const {html,Markdown,Icon}=globalThis.pipChatUiFixture;",
    };
    const hooks = registerHooks({
        resolve(specifier, context, next) {
            return (context.parentURL?.endsWith("/web/pip-question.js") ||
                context.parentURL?.endsWith("/web/thread-type.js")) &&
                mocks[specifier]
                ? {
                      shortCircuit: true,
                      url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`,
                  }
                : next(specifier, context);
        },
    });

    t.after(() => {
        hooks.deregister();
        delete globals.pipChatUiFixture;
    });
    const { PipQuestion } = await import(new URL("../web/pip-question.js", import.meta.url).href);
    const question = {
        id: "exact-question",
        text: "Which path?\n" + "Long question 日本語 👋 ".repeat(120),
        answer: { text: "Only the bounded repair.", requestId: "saved-reply", legacy: false },
    };
    const nodes = (node: any): any[] =>
        Array.isArray(node)
            ? node.flatMap(nodes)
            : node?.props
              ? [node, ...nodes(node.props.children)]
              : [];
    const { threadTypeLabel, ThreadTypeTag } = await import(
        new URL("../web/thread-type.js", import.meta.url).href
    );
    const controller = {
        threadType: "chat",
        workSupervisor: { conversationId: 42, status: "paused" },
    };

    assert.equal(threadTypeLabel(controller), "PiP");
    assert.equal(threadTypeLabel({ threadType: "chat" }), "Chat");
    assert.equal(
        nodes(ThreadTypeTag({ session: controller })).find((node) => node.type === fixture.Icon)
            .props.name,
        "pip",
    );
    const tree = PipQuestion({ question, conversationId: 42 });
    const rendered = nodes(tree);

    assert.equal(tree.props["aria-label"], "PiP question");
    assert.deepEqual(
        rendered.filter((node) => node.type === fixture.Markdown).map((node) => node.props.text),
        [question.text, question.answer.text],
    );
    assert.equal(
        rendered.some((node) => node.type === "textarea" || node.type === "form"),
        false,
        "answers use the normal composer",
    );
    assert.equal(sends.length, 0, "rendering never retries an answer");
    const retry = rendered.find((node) => node.type === "button").props.onClick;
    const first = retry();

    await retry();
    assert.deepEqual(sends, [[42, question]], "double activation cannot duplicate a pinned reply");
    release();
    await first;
    assert.equal(PipQuestion({ question: null, conversationId: 42 }), null);
    assert.equal(
        PipQuestion({
            question: { ...question, entryId: 7, answer: undefined },
            conversationId: 42,
        }),
        null,
        "a persisted ask is not duplicated in the pending display",
    );
    const outsideWindow = PipQuestion({
        question: { ...question, entryId: 7, answer: undefined },
        conversationId: 42,
        showText: true,
    });

    assert.equal(
        nodes(outsideWindow).find((node) => node.type === fixture.Markdown).props.text,
        question.text,
        "the pending ask remains readable when its saved entry is outside the transcript window",
    );
});
