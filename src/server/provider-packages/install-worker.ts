import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Installer-only child. No extension discovery/import or provider activation. */
process.on("disconnect", () => {
    // Parent died/restarted. This detached group contains only this installer and its npm children.
    try {
        process.kill(-process.pid, "SIGKILL");
    } catch {
        process.exit(1);
    }
});

process.once(
    "message",
    async (input: { source: string; directory: string; npmCommand: string[] }) => {
        let installed = false;

        try {
            const manager = new DefaultPackageManager({
                cwd: input.directory,
                agentDir: input.directory,
                settingsManager: SettingsManager.inMemory({ npmCommand: input.npmCommand }),
            });

            await manager.install(input.source);
            installed = true;
        } catch {
            // Never send command output, registry credentials, or arbitrary npm diagnostics to the parent.
        }

        if (!process.connected) {
            process.exit(1);
        }

        process.send?.({ installed }, () => process.exit(installed ? 0 : 1));
    },
);
