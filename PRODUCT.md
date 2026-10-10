# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The owner works with existing local Herdr agents and shells on desktop, and mostly views and prompts agents from a phone. Other signed-in people collaborate in shared, app-managed Pi conversations. Private Herdr work belongs to the owner alone.

## Product purpose

Pi Coop is a self-hosted Pi collaboration app built from Pocket. Keep existing private work running where it is, and make a selected conversation shared through an explicit import into Pi Durable.

## Operating context

Herdr groups instances, workspaces, tabs and panes. Ordinary private Pi processes keep their own journals. Pi Durable executes and stores managed conversations. Import archives the original file unchanged and copies one selected branch without replaying its work.

The user chose Herdr GPUI as the model for private desktop terminal behavior, navigation and shortcuts. Desktop should default to Terminal. Mobile should favor agent Chat, with Terminal available when needed. iOS Safari is a requested browser target, not yet a verified platform claim.

## Capabilities and constraints

- The app owner alone can discover, read or control private Herdr content.
- Chat and Terminal are views of the existing process, not separate agent runs.
- Use Herdr's structured client protocol for Terminal, with GPUI feature parity as the target. A polling text snapshot or ANSI-only replacement does not meet that target.
- Desktop actions use Herdr shortcuts directly. Only mobile has the bottom key/action helper bar.
- Terminal navigation preserves typing focus. The first mouse click reaches Herdr without a separate activation click or browser-side clicked border. Chat fields and dialogs keep focus when deliberately opened.
- Opening Terminal connects automatically and keeps the connection across navigation. Reconnect to fresh state after transport failure, never replay input. Explicit disconnect and owner-access loss stop reconnection.
- Keep terminal chrome small: top tabs, an import icon on supported agents, notices in a bottom status area, and keyboard help behind an icon.
- Shared means access under Pocket's signed-in and scoped-user rules, not anonymous internet access. Source archives stay owner-only.
- Keep Pocket's managed-session interface and use it for private agent Chat where possible.
- Browser-reserved shortcuts, clipboard permissions and mobile input differ from native desktop. State limits rather than claiming identical behavior.
- Test with generated journals, mock models, disposable sessions and isolated app data. Do not send input to the owner's existing panes as a development test.
- No automatic app restart, publishing, deployment or Git push during development.

## Brand commitments

Use Pi Coop as the display name and `pi-coop` as the package and command name. Retain upstream attribution and licenses. The private desktop interface should closely follow the user's Herdr GPUI reference. Public conversations retain Pocket's existing interface. This is not a redesign of the whole app.

## Evidence on hand

The user supplied screenshots of the current Private sidebar and Herdr GPUI on 2026-10-09. The current nested sidebar is a negative reference. GPUI's compact Spaces and Agents lists, top tabs and split terminal area are the positive reference.

The local Pocket, Collie and Herdr GPUI sources provide implementation and licensing evidence. See FORK.md and docs/research/. Synthetic browser fixtures are test data, not examples of the owner's live sessions.

## Product principles

- Keep execution with its current owner until an explicit import.
- Match the desktop terminal workflow and the mobile agent workflow, rather than forcing one layout onto both.
- Reuse existing client and rendering contracts; do not maintain a second terminal state machine unnecessarily.
- Treat unknown input delivery as unknown. Do not replay it or imply that restarting Pocket cancelled it.

## Open decisions

Remote and multi-server connection management, finer-grained shared membership, and native desktop/iOS packaging remain later work. Terminal parity requires a tested feature matrix; no complete-parity claim has been validated yet.
