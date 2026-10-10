/** Build the locally installed editor modules on first use, keeping the app's no-build workflow. */
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import { APP_ROOT } from "../config.ts";
import { send } from "./io.ts";

let cached: { stamp: string; output: Promise<string> } | undefined;

export async function serveEditor(response: ServerResponse): Promise<void> {
    const entry = join(APP_ROOT, "web", "editor-library.js");
    const stamps = await Promise.all(
        [entry, join(APP_ROOT, "package-lock.json")].map(
            async (file) => (await stat(file)).mtimeMs,
        ),
    );
    const stamp = stamps.join(":");

    if (cached?.stamp !== stamp) {
        const output = build({
            entryPoints: [entry],
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
            target: "es2022",
            minify: true,
            legalComments: "inline",
        }).then((result) => result.outputFiles[0]!.text);

        cached = { stamp, output };
        output.catch(() => {
            if (cached?.output === output) {
                cached = undefined;
            }
        });
    }

    send(response, 200, await cached.output, "text/javascript; charset=utf-8", {
        "cache-control": "no-cache",
    });
}
