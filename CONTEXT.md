# pi-tava

Terms for continuing private and shared Pi work through multiple interfaces.

## Language

**Adoption**:
Continuing a stopped Pi session's selected conversation branch in the app, while preserving the original as an archive. Adoption transfers future work, not a live process or every extension's behavior.
_Avoid_: Live attachment, dual-writer session, lossless runtime migration

**Private session**:
Existing work in Herdr that only the app owner can view or control through the app. Opening it does not adopt it. Private does not imply secrecy from the machine owner or isolation from a shell-capable collaborator.
_Avoid_: Sandboxed session, isolated session

**Shared session**:
An app-managed conversation available to signed-in people under the app's access rules. Importing private work can create a shared session while keeping the full original archive private. "Public" in this product means shared within the app, not anonymous internet access.
_Avoid_: Public internet session

**Mirror**:
A view of Herdr's instances, workspaces, tabs and panes that leaves their running work in place.
_Avoid_: Imported session, migrated process

**Trusted collaborator**:
A person whom the machine owner trusts with the access granted to the session, including the consequences of any permitted agent actions.
_Avoid_: Untrusted tenant
