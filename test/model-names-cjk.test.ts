// Authoring gate: model-name parsing is an authority boundary, not permission to choose a model.
// These cases exercise CJK adjacency with the existing longest-name, short-name and provider rules.
// Type-only model fixtures keep the real parser runnable without installed runtime dependencies.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { indexed, modelsNamed, personNamed } from "../src/server/model-names.ts";

const model = (provider: string, id: string, name = id) => ({ provider, id, name }) as Model<Api>;

const sol = model("openai", "gpt-6.1-sol");
const base = model("openai", "gpt-6.1");
const all = [base, sol];

test("Han, Kana and Hangul may touch a Latin model name without changing which model was named", () => {
    for (const text of [
        "用gpt-6.1-sol吧",
        "请用GPT6.1 Sol来处理",
        "モデルgpt-6.1-solでお願いします",
        "カナgpt-6.1-solカナ",
        "모델gpt-6.1-sol로해주세요",
        "用gpt-6.1-solカナ한글",
    ]) {
        assert.deepEqual(modelsNamed(text, all, true), [sol], text);
        assert.equal(personNamed(text, sol, all), true, text);
        assert.equal(personNamed(text, base, all), false, text);
        assert.deepEqual(modelsNamed(text, [base], true, all), [], text);
    }
});

test("CJK boundaries do not split ordinary words or authorize incidental short names", () => {
    const kiwi = model("acme", "kiwi-k3", "Kiwi K3");
    const choices = [sol, kiwi];

    for (const text of ["用gpt-6.1-solutions吧", "ใช้gpt-6.1-solนะ", "我的K3电脑"]) {
        assert.deepEqual(modelsNamed(text, choices, true), [], text);
    }

    assert.deepEqual(modelsNamed("用prefixgpt-6.1-sol吧", [sol]), []);
    assert.equal(personNamed("请用Kiwi的K3吧", kiwi, choices), true);
    assert.deepEqual(modelsNamed(indexed(["请用Kiwi", "K3吧"]), choices, true), []);
    assert.deepEqual(modelsNamed(indexed(["请用gpt-6.1", "sol吧"]), [sol], true), []);
});

test("CJK-adjacent names still require an unambiguous provider in the same message", () => {
    const hub = model("github-copilot", sol.id);
    const choices = [sol, hub];
    const providerName = (provider: string) =>
        provider === "github-copilot" ? "GitHub Copilot" : "OpenAI";

    const pays = (text: string | string[]) => {
        const said = indexed(text);

        return choices.filter((each) => personNamed(said, each, choices, providerName));
    };

    assert.deepEqual(pays("用gpt-6.1-sol吧"), []);
    assert.deepEqual(pays("用gpt-6.1-sol via GitHub Copilot吧"), [hub]);
    assert.deepEqual(pays("用gpt-6.1-sol on OpenAI吧"), [sol]);
    assert.deepEqual(pays(["用gpt-6.1-sol on", "OpenAI吧"]), []);
});
