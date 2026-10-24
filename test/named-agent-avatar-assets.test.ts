// Resolve the actual browser import map against the public vendor allowlist; no server or browser is started.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { VENDOR, WEB } from "../src/server/http/assets.ts";

for (const [name, contents] of [
    [
        "the official React Blobatar entry links through its scoped Preact runtime without global React aliases",
        'export { Blobatar } from "blobatar/react"; export { thinking, idle } from "blobatar/expression";',
    ],
    [
        "the real app static entry links its conversation header and tab modules through the public browser assets",
        'import "./app.js";',
    ],
]) {
    test(name!, async () => {
        const document = readFileSync(join(WEB, "index.html"), "utf8");
        const script = /<script type="importmap">([\s\S]*?)<\/script>/.exec(document);

        assert.ok(script);
        const { imports, scopes } = JSON.parse(script[1]!);

        assert.equal(
            imports.react,
            undefined,
            "other app/extension modules do not inherit the adapter",
        );
        assert.equal(imports["react/jsx-runtime"], undefined);
        await assert.doesNotReject(
            build({
                stdin: {
                    contents: contents!,
                    resolveDir: WEB,
                    sourcefile: "avatar-entry.js",
                },
                bundle: true,
                write: false,
                platform: "browser",
                format: "esm",
                logLevel: "silent",
                plugins: [
                    {
                        name: "public-browser-import-map",
                        setup(builder) {
                            // Lazy runtime surfaces (such as the separately built editor) are not this static-header check.
                            builder.onResolve({ filter: /.*/ }, ({ path, kind }) =>
                                kind === "dynamic-import" ? { path, external: true } : undefined,
                            );
                            builder.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
                                const parent = Object.entries(VENDOR).find(
                                    ([, file]) => file === importer,
                                )?.[0];
                                const address = parent ? `/vendor/${parent}` : "";
                                const scope = Object.keys(scopes ?? {})
                                    .sort((a, b) => b.length - a.length)
                                    .find((prefix) => address.startsWith(prefix));
                                const target =
                                    (scope ? scopes[scope][path] : undefined) ?? imports[path];
                                const file =
                                    typeof target === "string" && target.startsWith("/vendor/")
                                        ? VENDOR[target.slice("/vendor/".length)]
                                        : undefined;

                                if (!file) {
                                    return {
                                        errors: [
                                            { text: `No public import-map target for ${path}` },
                                        ],
                                    };
                                }

                                return { path: file };
                            });
                        },
                    },
                ],
            }),
        );
    });
}
