/** Native process confinement shared by local and SSH workflow execution. */
export function sandboxProfile(readOnly: boolean, writeRoots?: readonly string[]): string {
    return [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny mach-lookup)",
        "(deny appleevent-send)",
        ...(readOnly || writeRoots !== undefined
            ? [
                  "(deny file-write*)",
                  '(allow file-write* (literal "/dev/null"))',
                  "(deny signal)",
                  ...(!readOnly && writeRoots !== undefined
                      ? writeRoots.map(
                            (root) => `(allow file-write* (subpath ${JSON.stringify(root)}))`,
                        )
                      : []),
              ]
            : []),
    ].join("\n");
}
