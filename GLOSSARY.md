# Pi Coop collaboration

The shared work people and agents organize in Pi Coop.

## Language

**Project**:
A named collection of related threads and Work Items, with a default working directory for newly created threads.

**Goal**:
A section of work within one project that groups threads and Work Items and can remain empty. A goal is Active or Completed, and can be archived with its work.

**Thread**:
One conversation with Pi, with its own history and working directory. A thread can stand alone, belong directly to a project or goal, or be a member of a Work Item.
_Avoid_: Session when describing project organization; session remains the existing product label for starting a thread.

**Chat**:
A thread for conversation, initially created without a project or goal. Its type does not prevent it from being organized within a project or goal later.

**Worker**:
A thread for project work. New threads created within a project start as Workers.

**Reviewer**:
A thread that takes responsibility for reviewing and fixing the current work. Substantial remaining implementation belongs in a fresh Worker.

**Land**:
A thread for local integration, commits, hook fixes, worktree cleanup and checking the impact of integration changes.

**Publish**:
A thread for external delivery, including pushes, pull requests and ticket updates.

**Handoff**:
A transfer of responsibility from a thread to a new successor, accompanied by a brief describing the work and its current state. Related handoffs can continue the same work or start subsequent work.

**Work Item**:
One piece of work carried through related threads, named after its first thread. Its members share placement and are archived or restored together.

**Landed**:
Work that has completed its local integration procedure. Landing does not imply publication or readiness to publish.

**Done when**:
An automated completion check for a thread, separate from the project goal that organizes its work.
_Avoid_: Goal when describing the completion-check feature.
