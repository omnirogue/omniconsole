NA-5 integration follow-up

- WP-9b now persists single-stage layouts in profile state through guarded workPlanLayouts RPC methods, with save/apply/rename/delete and authoritative list refreshes. The source remains injectable.
- WP-10b is still absent: the library executable-only source TODO remains for that separate package.
- NA-2's advanced contract has only a uniform model/effort, not per-seat actors or an arbitrary WorkPlan. Uniform single-worker stages can round-trip through Custom. Multiple stages and unrepresentable topology/actor overrides are refused without writes. Extend the contract before accepting these configurations.
- The host contract says unset readsFrom means _every earlier stage_, not just the previous stage. The control follows that contract and offers an explicit subset with a reset to automatic.
- The receipts link opens the existing Done When checklist (verification status, not individual evidence bodies). Verdicts/files open the existing seats/plan history component. There is no dedicated timings viewer in this checkout; timings remain authoritative inline facts. A full evidence/timing viewer integration is still needed.
- UI writes use the existing Up next controller and its unavailable-host refusal. No runtime or RPC contract was changed.

- Per-seat model/effort (S-7, brief 54 lines 24 and 43) is NOT built. What is authored here is
  one model/effort per stage, and the UI now says exactly that ("Applies to every seat in this
  stage. Per-seat model and effort are not authored here yet.") instead of the old claim that the
  host contract forbids seat overrides — which was false: `WorkPlanWorkerNode.seats?:
WorkPlanActor[]` (src/shared/work-plan-types.ts:108) already carries per-seat actors and
  up-next-plan-advanced.ts:76 passes them through. The gap is the Up next AUTHORING contract, and
  closing it is five coupled edits, none of them renderer-local:
  1. `UpNextAgentAdvanced` gains `seats?: { model?: string; effort?: string }[]` with a
     `max(UP_NEXT_MAX_SEATS_PER_STAGE)` array in `upNextAdvancedSchema` (src/shared/up-next-types.ts,
     src/shared/up-next-draft-schema.ts).
  2. The fragment contract carries actors, not just a count: `WorkPlanFragmentNode.seats?: number`
     (src/shared/work-plan-fragments.ts:26) has to accept `WorkPlanActor[]` so
     `appendWorkPlanFragment` can lower them.
  3. `up-next-plan-edit.ts:225-233` lowers `advanced.seats[i]` onto `node.seats[i]`, defaulting each
     unset seat to the stage actor; `up-next-blocks.ts` reads them back so a committed stage
     round-trips to the same block.
  4. `custom-stage-adapter.ts:56-72` stops answering `{ reason: 'unsupported' }` for differing seat
     actors and preserves them.
  5. `AgentModelFields` renders one `BuildReviewModelEffortFields` per seat when `block.n > 1`, each
     writing `advanced.seats[i]`, and the two tests that assert the limitation
     (AgentModelFields.test.tsx, custom-stage-adapter.test.ts) become authoring/lowering tests.
     Steps 2-4 are shared + main-runtime files owned by other seats this round, so the honest UI copy
     landed first and the feature is filed here rather than half-built.
