# Existing estate dispatch classifier

This packages the existing Studio estate router and its stdlib JEV helper, captured 2026-10-07. Source:
`~/Work/Ops/autonomy/bin/{omni_route.py,jev_route.py}`.
The Studio working copy included uncommitted pin and no-auto-relaunch safeguards.
Its source checkout was not changed. Original and packaged hashes and source revision are in manifest.json.
The only Python change removes the prompt preview from the local decision log;
timestamps, task hash and decisions remain. The JEV helper is unchanged.

No JEV questions, thresholds, retries or escalation instructions were changed.
This resource is a portability fallback for hosts without the estate checkout.
An explicit OMNI_ROUTE_SCRIPT wins; an installed estate script retains precedence
and can use its already-running optional semantic service. The app never starts
that service. The route command itself requires Python 3 and the Python standard
library only. Existing credential resolution remains inside jev_route.py; this
bundle contains no credentials.

The TypeScript adapter handles off/shadow/live, host-scoped advertised model
availability and launch receipts. Its conservative family preference order is an
unmeasured policy, not a latency or quality benchmark. Served model identity and
completed useful outcomes must be measured separately before tuning the policy.

2026-10-11: the tier table now sends standard work, and Claude-pinned fast work, to Sonnet 5.5 at medium,
matching estate commit 84f9beebd7 (Sal, OmniOS decision 264). Frontier stays Opus 5.5 at high. On hosts with
model discovery the TypeScript adapter picks the model, so its standard order now lists Sonnet ahead of Opus;
that one step rests on a 10-ticket replay, the rest of the order is unchanged. manifest.json records the new
packaged hash.
