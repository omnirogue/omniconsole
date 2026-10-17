# Session owner lookup timing

`omni session find-owner --json` includes an optional `result.timing` on builds
with this instrumentation. Older builds omit it; missing timing is unknown,
never zero. Selection rules, JEV questions, thresholds and fallback are unchanged.

`totalDurationMs` is monotonic server wall time from immediately before sidebar
reading until the result is ready. CLI startup, socket admission and response
serialization are outside this boundary; measure CLI wall time separately.

Each phase has `phase`, `startedAtMs` relative to that boundary and `durationMs`:

| Phase | Work measured |
|---|---|
| sidebar | Read current sidebar rows |
| scope | Resolve the requesting session's workspace/folder/repository |
| live-inventory | Observe current session state and chain ownership |
| matching | Entire live and optional past matching operation |
| transcript-search | Local transcript query and sidebar join, once per lookup |
| file-conflicts | Read changed files, only when the request names files |
| live-goal / past-goal | Read each candidate's first genuine request |
| live-jev / past-jev | Credential resolution and both-order JEV judgments |
| past-observation | Observe a past hit held by a sidebar row |
| past-organization | Check whether a closed conversation was deleted or hidden |

Candidate reads and JEV judgments run concurrently, and `matching` contains its
subphases. **Do not add phase durations to claim total wall time.** Use offsets
to show overlaps. An absent phase means it was not invoked, not that it took zero
time. A span records elapsed work even if a dependency rejects; it is not proof
that the dependency succeeded. Consult the normal result's errors and coverage.

Timing records include only fixed phase names and numbers: no prompt, title,
tool arguments, transcript, credentials or additional persistent telemetry.
The optional result field preserves older clients and does not expand the
local-only admission policy of `sessionManage.findOwner`.
