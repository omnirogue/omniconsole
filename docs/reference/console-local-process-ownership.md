# Console local process ownership

An activated Console job runs through the configured in-process `LocalPtyProvider`,
even when ordinary terminals use the persistent daemon. This is a same-host route;
SSH, WSL and remote runtime launches cannot borrow its authority.

The main process creates a frozen launch gate only after checking the persisted
Console claim, activation intent, approved job digest, pending attempt, workspace
and current signed-in principal. A private `WeakMap` binds authority to that exact
object. Copied or serialized gate fields confer no authority. Native spawn checks
the actual working directory and task environment, rechecks the principal and
stored admission after asynchronous preflight, and consumes the grant once.

The native observer must prove the exact held shell process and its birth time.
The provider command remains held until the server acknowledges that process and
the acknowledgement is stored in the existing process journal. The original
signed-in session lease is checked again before registration and release. Plain Hub task
IDs, `local_bound` runs and raw daemon gate requests remain fenced. The daemon
protocol and its launch guards are unchanged.

Native gate IDs route input, stop, inventory and retained exit observations back
to the in-process provider. Workspace removal verifies failed native stops with
that provider; absence from the daemon inventory is not evidence of native exit.

This execution does not gain the daemon's restart survival. A normal app quit
stops in-process PTYs. After a crash or restart, the persisted process journal
remains available, but the old in-memory observer cannot be reconstructed from
its receipt. Missing observation remains `unverifiable`; the UI must not report
stored `ready` state as running, report success, infer an exit or automatically
restart the same Dispatch. Listing a running execution requires a current exact
native observation before returning the first restored view. A new attempt
requires the canonical server to settle the previous execution and admit the
retry. Losing a transport connection alone never proves process death.
