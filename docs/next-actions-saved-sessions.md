# Next Actions, shared handoffs, and session filing

Next Actions schedules what happens after the current work. It uses the existing handoff system that Work / Needs You / Waiting uses; sending a handoff during a session continues to work through that same system.

## Shared contracts

| Operation | Existing hub route (desktop BFF prefix: `/api/gtd/hub`) |
| --- | --- |
| Send task handoff | `POST /api/team/tasks/{taskId}/handoffs` |
| Send without a task | `POST /api/handoffs` |
| Needs You / sent Waiting queue | `GET /api/handoffs?view=attention` / `?view=sent` |
| Read / reply / forward | `/api/handoffs/{threadId}`, `/entries`, `/forward` |
| Review / returned file | `/api/handoffs/{threadId}/review`, `/files/return` |

`next-step-send`, `session-follow-up-io`, and the outcome host's `session-outcome-handoff-adapter` all use `consoleHandoffClient`. The existing hub owns threads, file versions, access, responses and review decisions. No new handoff endpoint or queue is introduced.

The Agents dashboard and session sidebar share `buildDashboardSnapshot` and the runtime agent store. `buildAgentPaneSnapshot` is a projection of that dashboard snapshot. Canonical Done sessions now appear in Done immediately and remain there instead of moving there after ten minutes and being archived after ten hours. Explicit archive and workflow review requirements remain effective. Unknown/offline state is not proof of success.

## Once everything is done

- **Me** (default): keep the session open in Done.
- **End session**: close the idle session through the existing close/history action.
- **Save session**: retain the session in Saved Sessions, below Done, with an optional folder.

The folder chooser is shown only for Save session. Saved Sessions has a New folder control; folders support rename, delete, move and collapse. Deleting a saved folder keeps its sessions at the Saved Sessions root. Active work and new requests still surface through the existing runtime status projection. Opening a saved session uses the normal session activation path.

These are personal, per-device presentation preferences, persisted with existing session-folder metadata. Saving keeps the existing session and transcript; it is not an artifact export or a cloud backup. Artifact and handoff file locations continue to use the existing artifact system. The desktop applies a scheduled finish while it is open (including after restart), after reading the current verified outcome revision from the execution host. It does not independently send handoffs or infer success from an agent becoming idle. A pending review, veto, failed verification, busy pane or unreachable host prevents automatic filing/closing.

## Acceptance limits (2026-09-14)

Targeted automated tests cover the shared status projection, handoff routes, finish guards, saved folder persistence and actual React folder controls. These checks do not establish a successful cross-computer handoff: the second account still needs its distinct hub employee mapping and recipient-side live verification. No new desktop release is claimed by this source change.
