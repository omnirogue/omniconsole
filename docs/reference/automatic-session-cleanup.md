# Automatic session cleanup

Automatic cleanup requires an explicit `automaticSessionCleanupProtection` policy on the execution owner. An absent or malformed policy keeps sessions running. Configure owner-local protected workspace paths and pane keys, an IANA time zone, and whether to protect sessions started today. Routine, pinned, saved, and unverifiable work is retained. This policy does not change launch concurrency or manual close behavior.

`idleAutoCloseMode` remains `off`, `shadow`, or `on`. Prepare the protection policy in Shadow mode and read it back before enabling On. The existing restore flood guard remains required. The desktop hibernation and idle-close paths share the protection check and repeat it before acting.

Without a desktop window, the existing session-owner pass may sleep an idle Claude or Codex terminal it already owns. It requires an uninterrupted idle interval, current process identity, a completed turn with no pending work, authoritative protection facts, and exact provider/account resume metadata. It writes and flushes the checkpoint before stopping the exact PTY, then verifies its captured descendants have exited. Unknown identity, organization state, account, or process liveness keeps the session running. The remembered inventory only identifies where to look; it is not evidence that a process is idle or dead. Headless sleep currently requires a POSIX owner and sessions previously recorded in that owner's inventory.

A stale desktop save preserves owner-authored resume checkpoints. An accepted close, a replacement process incarnation, or a newer checkpoint retires them through the existing session persistence reconciliation. Sleeping preserves conversation history; it is not sidebar archiving.

For explicitly disposable supervised work, `orchestration worker-start --close-on-completion` opts a newly created local worker into cleanup after the coordinator accepts its `worker_done` result. Hosts must advertise `orchestration.worker-completion-policy.v1`. Existing workers retain manual release behavior. The option is refused for an existing terminal or remote dispatch; select the intended owner first. Output and resume metadata are archived before release. Current protection and process ownership are checked again at release, and unresolved cleanup remains pending for reconciliation.

Bounded workflow checks and acceptance helpers use the existing process-group cleanup boundary, including children left after their parent exits. Ordinary interactive sessions do not become disposable helpers.

Mixed runtime versions are expected. Check the paired execution owner's version and capability rather than a different local CLI shim. Old owners, native Codex chats, standalone terminal agents, and independent workqueue services are not covered merely by updating a desktop app.

A session waiting on its own review page (`docs/reference/artifact-review-source-delivery.md`) is
slept by the same hibernation timer and headless pass after `reviewWaitLiveMinutes` instead of the
idle window. Only its started-today hold and its reply's own open question are lifted; every other
protection, keep and the policy requirement still apply.
