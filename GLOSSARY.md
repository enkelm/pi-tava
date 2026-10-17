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
A thread for research, planning, implementation and focused tests. New project threads default to Worker.

**Researcher**:
A thread for a focused investigation, either starting a Work Item or contributing evidence within existing work. Its output is cited findings and application guidance, not feature implementation.

**Reviewer**:
A thread that independently reviews the current work in a bounded pass. Small remaining repairs belong in Follow-up; substantial implementation belongs in a fresh Worker.

**Follow-up**:
A thread for bounded repairs after review or Pull intake, with a short self-review limited to its delta and immediate integration points.

**Pull**:
A thread for reading upstream repository, pull request and issue information and integrating upstream changes locally, independent of the work's current stage.

**Land**:
A thread for human-authorized local integration, commits, hook fixes, cleanup and integration-impact checks. Entering Land does not mean review or tests passed or authorize mutations.

**Publish**:
A thread after Land for external delivery, including pushes, pull request creation and ticket updates. Each external action needs separate human approval.

**Handoff**:
A human-requested transfer, executed by the source agent, to a successor thread with a brief describing the work and its current state. It continues the same Work Item or starts distinct new work; its intended type is explicit or clarified with the human, not an agent readiness decision.

**Work Item**:
One piece of work carried through related threads, named after its first thread. Its members share placement and are archived or restored together.

**Landed**:
Work that has completed its local integration procedure. Landing does not imply publication or readiness to publish.

**Done when**:
An automated completion check for a thread, separate from the project goal that organizes its work.
_Avoid_: Goal when describing the completion-check feature.
