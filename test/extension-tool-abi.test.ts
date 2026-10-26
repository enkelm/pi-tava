// Loader admission only: real module imports and staged web registrations, no installed Pi runtime.
// The registry fixture accepts every descriptor; only the production loader can refuse its ABI.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

test("tool ABI admission preserves web API 1 and rejects incompatible edits before installation", async () => {
    const root = mkdtempSync(join(tmpdir(), "coop-tool-abi-"));
    const builtIn = join(root, "built-in");
    const dropIn = join(root, "drop-ins");
    const installed = new Map<string, Extension>();
    const registry = {
        snapshot: () => ({ installed: () => [...installed.values()] }),
        install: (extension: Extension) => installed.set(extension.name, extension),
        uninstall: (extension: Extension) => installed.delete(extension.name),
    } as unknown as Registry;
    const webs = new ExtensionWebs();
    const loader = new ExtensionLoader(
        registry,
        {} as PocketHost,
        { builtIn, dropIn },
        () => true,
        { webs },
    );
    const path = join(dropIn, "abi.ts");
    const source = (declaration: string, member = "", version = 2) => `/** ABI fixture. */
export const pocketApi = 1;
${declaration}
export default (_host, web) => {
    web.route("GET", "v", () => ({ version: ${version}, api: web.api }));
    return { name: "abi-fixture", ${member} };
};
`;

    const answer = () => {
        const found = webs.match("abi", "GET", ["v"], { role: "owner" });

        assert.ok(found !== undefined && "route" in found);

        return found.route.handle({} as never);
    };

    const initial = { version: 1, api: 1 };

    mkdirSync(builtIn);
    mkdirSync(dropIn);

    try {
        // Existing web-only API-1 modules remain compatible without a tool-ABI declaration.
        writeFileSync(path, source("", "", 1));
        await loader.reload("abi.ts");
        assert.deepEqual(answer(), initial);
        const previous = installed.get("abi-fixture");

        assert.ok(previous);

        // These are descriptor-presence cases, not assertions about Durable's callable/worker ABI.
        for (const member of [
            'tools: [{ name: "abi_probe", description: "Probe", parameters: { type: "object" }, execute: async () => ({ output: [] }) }]',
            'wraps: [{ tool: "abi_probe" }]',
            "hooks: [{ handlers: { afterTool: (_call, result) => result } }]",
        ]) {
            writeFileSync(path, source("", member));
            await assert.rejects(loader.reload("abi.ts"), /durableToolApi = 2.*content to output/);
            assert.equal(installed.get("abi-fixture"), previous);
            assert.deepEqual(answer(), initial);
        }

        for (const version of ["1", "3", '"2"']) {
            writeFileSync(path, source(`export const durableToolApi = ${version};`));
            await assert.rejects(loader.reload("abi.ts"), /unsupported durableToolApi/);
            assert.equal(installed.get("abi-fixture"), previous);
            assert.deepEqual(answer(), initial);
        }

        // A beforeTool-only guard does not consume results and needs no migration declaration.
        writeFileSync(path, source("", "hooks: [{ handlers: { beforeTool: () => {} } }]"));
        await loader.reload("abi.ts");
        assert.deepEqual(answer(), { version: 2, api: 1 });

        writeFileSync(
            path,
            source(
                "export const durableToolApi = 2;",
                'tools: [{ name: "abi_probe", description: "Probe", parameters: { type: "object" }, execute: async () => ({ output: [] }) }]',
                3,
            ),
        );
        await loader.reload("abi.ts");
        assert.deepEqual(answer(), { version: 3, api: 1 });
        assert.equal(installed.get("abi-fixture")?.tools?.[0]?.name, "abi_probe");
    } finally {
        await loader.close();
        rmSync(root, { recursive: true, force: true });
    }
});
