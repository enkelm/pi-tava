/** Native process confinement shared by local and SSH workflow execution. */
export function sandboxProfile(readOnly: boolean): string {
    return [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny mach-lookup)",
        "(deny appleevent-send)",
        ...(readOnly
            ? ["(deny file-write*)", '(allow file-write* (literal "/dev/null"))', "(deny signal)"]
            : []),
    ].join("\n");
}
