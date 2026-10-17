# Next actions

Open Plus on a conversation to choose what must happen next. Use Review to select
reviewers, the maximum number of rounds and special instructions. Use Handoff to
choose the next agent or person. Add another outcome when the request has more
than one result. Finish instructions are optional when the request already says
what to produce and where it belongs.

Next actions are set here, not in chat. A message typed into a conversation is
sent to the agent exactly as written and is treated as work to do now, even when
it mentions a handoff, a reviewer or closing the session; OmniConsole never adds
next-step instructions to it.

Automatic outcome binding uses your latest submitted prompt. If you send a
follow-up before outcomes are saved, include the finish and destinations you
still want in that follow-up, or define them through Next. Once saved, outcomes
remain required until you explicitly change them.

Save & finish saves the whole outcome set and changes Plus to an editable lock.
The conversation enters Waiting automatically. Open the lock to inspect progress
or edit the saved plan; cancelling the editor leaves saved work alone. Every
committed outcome must have verified completion evidence before the conversation
can finish. A stopped or disconnected agent alone is not completion.

Completed actions and delivery receipts survive restarts and ordinary edits.
Adding an outcome keeps the existing receipts and reopens only the unfinished
work. Changes to already executed or uncertain actions can be refused to avoid
repeating a send or other external action; add a new outcome for new work.

A review round uses one result version for all selected reviewers. An authorized
writer can repair findings before the next round. Transferring ownership to a
person and asking that person for feedback have different completion conditions:
a feedback request remains open until its required response is verified.

Needs you identifies a required decision, permission, destination or other
specific blocker. Manual Snooze and Wait controls are retired. Hide remains a
visibility choice and does not pause the work or remove its outcomes.

Remote outcomes need a paired runtime on the execution host so work has an owner
when the desktop disconnects. Relay-only SSH sessions show a setup explanation
instead of saving an unattended plan they cannot continue. Reconnect to the
owning host to verify its current progress; the desktop never silently runs that
host's actions locally.

Task-bound Git continuation reports retain the exact worker report, physical exit and committed repository candidate for independent task verification. These evidence reports do not automatically publish a pull request. A successful stage or prepared outcome chain does not satisfy unfinished original task acceptance.

Card-linked native Sessions keep their original task and use successive execution
dispatches on that task's local projection. Saving waits for the source's accepted
worker report. Each action retains its selected model and workspace; reviews and
handoffs read the exact earlier dispatch reports. A missing launch response is
reconciled against its saved operation instead of starting another worker. If
unrelated work takes over the task projection, Next stops for reconciliation.

Console jobs admitted by the hub keep their sealed workflow contract. Next does
not convert those jobs into native Sessions or re-admit a changed instruction as
the same contract. A rejected sequential continuation remains visible as a blocker.
Worker completion reports execution progress; human acceptance and the original
task's completion remain separate.
