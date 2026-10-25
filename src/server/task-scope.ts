/** Give each Durable task phase its own ambient scope, independently of the commit that scheduled it. */
import type { AnyTask, RegistryReader, RegistrySnapshot, Task } from "@earendil-works/pi-durable";

type ExecutableTask = Task<unknown, { phase: string }, unknown, object>;

/** Keep the mutable registry with the loader; stable read-side identities preserve Durable recovery/replacement. */
export function scopeTaskRegistry(
    registry: RegistryReader,
    scope: <T>(run: () => T) => T,
): RegistryReader {
    const snapshots = new WeakMap<RegistrySnapshot, RegistrySnapshot>();
    const tasks = new WeakMap<AnyTask, AnyTask>();

    const scopedTask = (task: AnyTask): AnyTask => {
        let scoped = tasks.get(task);

        if (scoped === undefined) {
            const definition = (task as ExecutableTask).definition;
            const wrap =
                (handler: ExecutableTask["definition"]["abort"], receiver: object) =>
                (...args: Parameters<typeof handler>) =>
                    scope(() => handler.apply(receiver, args));

            scoped = {
                ...task,
                definition: {
                    ...definition,
                    phases: Object.freeze(
                        Object.fromEntries(
                            Object.entries(definition.phases).map(([name, handler]) => [
                                name,
                                wrap(handler, definition.phases),
                            ]),
                        ),
                    ),
                    abort: wrap(definition.abort, definition),
                },
            } as AnyTask;
            tasks.set(task, scoped);
        }

        return scoped;
    };

    return {
        subscribe: (listener) => registry.subscribe(listener),
        snapshot() {
            const original = registry.snapshot();
            let scoped = snapshots.get(original);

            if (scoped === undefined) {
                scoped = Object.freeze({
                    installed: () => original.installed(),
                    extension: (name: string) => original.extension(name),
                    tools: () => original.tools(),
                    sections: () => original.sections(),
                    tasks: () => Object.freeze(original.tasks().map(scopedTask)),
                    task: (name: string) => {
                        const task = original.task(name);

                        return task === undefined ? undefined : scopedTask(task);
                    },
                });
                snapshots.set(original, scoped);
            }

            return scoped;
        },
    };
}
