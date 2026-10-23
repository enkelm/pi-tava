# Changing Pi Coop's code while it runs

Pi Coop is often changed from inside itself: you may be running on the very server you edit, and so may everyone else using it. [AGENTS.md](../AGENTS.md) has the rules in short; this page is the whole of it.

Before you start, read [map.md](map.md) to find the code that you need, and the part of [architecture.md](architecture.md) about it. Say what you will change. Then wait for a yes, unless the person asked for exactly that change.

## When a change takes effect

| You save                             | What happens                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A file in `web/`                     | Each open browser loads again, at once. A syntax error makes the app blank for everyone, you too.                                           |
| A module in `src/server/extensions/` | The server installs it again about 300 ms later. If it does not load, the previous version continues to run, and the app reports the error. |
| Any other file in `src/server/`      | Nothing, until the server restarts.                                                                                                         |
| `docs/`, `test/`                     | Nothing runs it, except `npm test`.                                                                                                         |

So a change to an extension module and to other server code goes live in two parts. The module goes live at once, on the server as it started. A module that calls something that the rest of the change adds (a new member of the host, a new function in `src/server/`) breaks until the restart. Keep server and browser source on the same current API; finish the host change and ask the owner to restart rather than adding older-host aliases or fallback branches ([extensions/host.md](extensions/host.md)).

## After each save

- **`web/*.js`:** run `node --check web/<file>.js` at once, before anything else. If the app went blank, this tells why. Check the change in a browser (below). There are tests for a few of the web app's risks (`test/*-ui.test.ts`), not for most of it.
- **An extension module:** watch for the reload notice, or its error, in the app.
- **Other server code:** run `npm run check`.
- **A page in `docs/`:** a new page needs a row in `docs-site/src/sidebar.mjs`, or the docs build fails. To check the links, anchors, and the reference, run `cd docs-site && npm ci && npm run check` (the site's own packages, never at the root). The root `npm run check` also checks that the reference and `types/pocket.d.ts` agree.

Then, before you say that the change is done:

```sh
npm run format   # Prettier and ESLint's fixes
npm run lint
npm run check    # TypeScript
npm test         # every test; the browser tests need Chromium
```

`npm test` takes a few minutes. While you work, run the tests of the part that you changed (`node --test test/<name>.test.ts`). Run all of them before you say that the change is done, or before you ask for a restart. If you do not run a check, say which.

Keep [map.md](map.md), [architecture.md](architecture.md), and [features.md](features.md) true. When a change moves code, adds a dependency between parts, or changes what people see, update them in the same change.

## Check it on a copy

Never try a change on the server that people use, and never with their data. There are two ways:

- **A test.** `test/helpers.ts` opens the app on a temporary data folder with a scripted model (`openApp`, `newSession`, `say`, `until`). Most features have a test in `test/` that you can copy. `test/mobile-ui.test.ts` drives the whole web app in Chromium at the size of a phone.
- **A copy that you can open.** `test/serve.ts` runs the code of this folder on a temporary data folder. Its scripted model answers "echo: …", and costs nothing. It prints sign-in links for an owner and a guest. Web files and extension modules load again in it when you save them. Restart it after any other server change.

Prepare a fresh worktree before checking it. Ignored dependencies do not come with a worktree.
If an explicitly chosen sibling checkout has the same manifest and npm lockfile, the offline command
below makes an independent copy of its installed dependencies. It refuses an existing `node_modules`,
never runs install scripts, and never changes or links back to the source checkout:

```sh
node scripts/prepare-worktree.ts --from /path/to/matching/checkout
node scripts/native-preflight.ts
```

Preflight checks installed dependency metadata, private temporary logs, and cancellation/join of its
own child. It is not a passed test suite or browser check. Managed shell is deliberately offline,
including loopback: a listener-backed test or disposable server can still fail with `listen EPERM`.
Where a native profile supports listeners, `node scripts/native-preflight.ts --listen` adds a single
bind-and-close check. Do not retry a known denial unchanged or run outside confinement to evade it.
See [native validation commands and limits](../scripts/NATIVE-VALIDATION.md).

The copy runs until stopped. Only in a profile that permits its listener, background it so the tool
call can return. Use the target's authorized `$TMPDIR`, not a shared fixed `/tmp` filename:

```sh
umask 077
copy_dir=$(mktemp -d "${TMPDIR:?Use target-authorized TMPDIR}/coop-copy.XXXXXX")
nohup node test/serve.ts > "$copy_dir/server.log" 2>&1 &
printf 'Copy log: %s/server.log\n' "$copy_dir"
```

Read that log after startup for sign-in links and the copy's own process id. These links are local
test credentials; do not publish the log. A background command is not a managed ownership lease:
stop and join this copy before transferring the writer, and remove only its own log directory.

Where a local-app browser capability is available, open a link at the `mobile` viewport too, because
most people use a phone, and read its console for errors. The managed browser's public-document
reader cannot run JavaScript or open this local app; neither a successful listener probe nor a
memory-only test establishes rendered or device acceptance.

Stop the copy with the `kill <id>` that it printed. This also deletes its data; `kill -9` would leave the data in the temporary folder. Use that id, not `$!`: after `cd somewhere && node … &`, `$!` is the shell's id, not the copy's.

The copy listens on `127.0.0.2:8899`. Browsers keep cookies for each host, not for each port: a sign-in to a copy on `127.0.0.1` or `localhost` would sign the same browser out of the real server. macOS answers only on `127.0.0.1`. There, run `node test/serve.ts 8899 127.0.0.1`, and open the real server as `localhost` at the same time.

## Restarting

Server changes outside `extensions/` need a restart. Only the owner can, from Menu → **Restart server** (shown when Pi Coop runs under its launcher, as `pi-coop` does).

- **Never restart while your own tool call runs**, and never on your own. Finish the edit, run `npm run check` and `npm test`, and then ask the person to restart.
- Work that runs continues after a restart. A tool call that the restart stopped, and that is not safe to repeat, comes back to the model as interrupted.
- A server that does not start stops Pi Pocket for everyone, and you cannot correct it from the app. The launcher tries again and again, more slowly each time, and prints the error in its terminal. A correction of the file is enough: the next try uses it.

## Undo a change that breaks it

- **A blank app** (a syntax error in `web/`): the server is good, and your work continues. Correct the file; each browser loads again.
- **An extension that does not load:** the previous version still runs. Correct the file, or turn off the module in Menu → Extensions.
- **A server that does not start:** a person at the machine corrects the file, or puts it back with `git checkout -- <file>`. Look at `git diff` first: it can have other work in it. The launcher uses the file when it tries again.

Work in small steps, and check each step. Then the step to undo is small.

## Rules that are easy to break

The full list is in [map.md](map.md#rules-that-are-easy-to-break). These cost the most:

- **Stored data is forever.** Pi Pocket reads back the document kinds in `src/server/docs.ts`, the entry kinds and message markers in `src/server/entry-format.ts`, and the fields of `config.json` from what it stored. Never rename them, and never change what they mean: add new ones beside them. An older Pi Pocket can read a newer `config.json`, so a new field must be one that it can ignore.
- **Only erasable TypeScript** in `src/`: no `enum`, no `namespace`, and no parameter properties. Imports end in `.ts`. Node runs the code as it is.
- **The web app has no build.** It is plain ES modules with Preact and htm. Lay out the markup by hand ([AGENTS.md](../AGENTS.md) tells how). In htm, a line break is not a space.
- **Phones first.** Controls must be big enough for a thumb (about 40 px), nothing can be wider than the screen, and back closes what opened last (`useBack`, [map.md](map.md#adding-things)). Check at 390 × 844.
- **Do not commit, push, or publish** unless the person asks. Show the diff instead.
