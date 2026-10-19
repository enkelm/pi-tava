/** Real disposable files in a separate POSIX namespace; no SSH, owner resources or command execution. */
import { join, posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export class NamespaceEnv extends NodeExecutionEnv {
    override readonly id: string;
    readonly root: string;
    disconnected = false;

    constructor(root: string, id: string, cwd = "/project/app") {
        super({ cwd });
        this.root = root;
        this.id = id;
    }

    path(path: string) {
        return join(this.root, path === "~" ? "/home/remote" : posix.resolve(this.cwd, path));
    }

    override async absolutePath(path: string) {
        return {
            ok: true as const,
            value: path === "~" ? "/home/remote" : posix.resolve(this.cwd, path),
        };
    }

    override async canonicalPath(path: string, ctx: typeof BACKGROUND_CONTEXT) {
        if (this.disconnected) {
            return err<string, FileError>(new FileError("unknown", "Connection lost"));
        }

        const result = await super.canonicalPath(this.path(path), ctx);

        return result.ok
            ? {
                  ok: true as const,
                  value: posix.resolve("/", posix.relative(this.root, result.value)),
              }
            : result;
    }

    override fileInfo(path: string, ctx: typeof BACKGROUND_CONTEXT) {
        return super.fileInfo(this.path(path), ctx);
    }

    override openDirReader(path: string, ctx: typeof BACKGROUND_CONTEXT) {
        return super.openDirReader(this.path(path), ctx);
    }

    override openBinaryReader(
        path: string,
        options: { noFollow?: boolean } | undefined,
        ctx: typeof BACKGROUND_CONTEXT,
    ) {
        return super.openBinaryReader(this.path(path), options, ctx);
    }

    override exec(): never {
        throw new Error("Resource discovery must not execute scripts on either host.");
    }
}
