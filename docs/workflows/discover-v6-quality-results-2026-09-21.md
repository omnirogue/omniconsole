# Discover revision 5 quality check (2026-09-21)

Six new cases were frozen before output in
`quality-gate-discover-v6-2026-09-21.json` (SHA-256
`37c24831c14d542a6f2864aed411dd1c6fee09bcab448518b32ad334148bee2f`).
The complete batch evaluated clean source HEAD
`45aba3e16de19925d93984691a16927620fb11a5`, which merged the revision 5
patch at `331f56347d089be163ffa7c613e5e70fd2311a0b`. The only later product
differences through integration HEAD `794fbd7b2b4278f05f43b82ae1715ee3b8e05799`
are provisional UI projection before cluster ballots and Setup copy/localization;
the Discover program, model prompts, provider launcher and completed output
projection are unchanged. Those later UI states were not exercised in this batch.

| Arm | Seeded distinct roots | Confirmed false positives | Duplicates | First-attempt completed |
| --- | ---: | ---: | ---: | ---: |
| Discover workflow | 4/4 | 0 | 0 | 6/6 |
| Claude Sonnet 5, low effort | 4/4 | 0 | 0 | 6/6 |
| Claude Sonnet 5, high effort | 4/4 | 0 | 0 | 6/6 |

Case 01 supplied two independent defects at the same source span with the
identical three-token `issueKey`. Its three finder calls returned six raw
proposals. Replaying the old revision 2 preselector on those exact frozen
finder outputs selected one candidate and discarded the negative-quantity
defect; revision 5 selected four under the case's four-candidate cap, then
two independent clustering votes yielded both distinct causes, each with
three supporting proposals. Two raw entries exceeded the cap, but the
distinct cause was among the four selected before clustering, so this live
case does not independently prove the post-cluster cap move. Regression tests
cover that boundary. Cases 02 and 03 each found their seeded defect, and
cases 04–06 were clean controls. This is a parity result against both
single-model comparators, not evidence of an overall quality gain.

The workflow made 35 accepted logical calls (24 Claude, seven Grok and four
Codex); the comparators made six Claude calls each. All 35 workflow calls
completed on ordinal one, with no explicit repairs. All 35 launch receipts,
terminal exits, and spawn/exit ledger pairs agree; all 12 baselines exited
and parsed successfully. The complete batch took 370.544 seconds. First
outcomes are the paired quality and reliability
measure; later repair outcomes would have been reported separately. Two
independent native Claude and Codex raters reviewed 18 randomized,
model-masked packets before the arm key was opened. They agreed on all 12
confirmed claims across all 18 packets, found no missed seeded roots, and
marked no duplicate or unsupported confirmed claim. These are preliminary
model ratings, without human adjudication.

Published [Claude Sonnet 5 token rates](https://platform.claude.com/docs/en/about-claude/pricing)
applied to native usage estimate $0.265 for workflow Claude calls, $0.049
for the low-effort comparator and $0.054 for the high-effort comparator.
The Grok CLI reports $0.045 for seven `grok-4.6-build` calls, so known
CLI-reported workflow cost is $0.310 versus $0.102 for both baselines
combined, excluding Codex. The exact Grok CLI billing basis was not
independently established; using published
[Grok 4.6 API rates](https://docs.x.ai/developers/pricing) as a different
scenario would instead add about $0.131. Codex and subscription/account
adjustments are unpriced here. None of these figures is an invoice.

Local QA artifacts (large raw native receipts are intentionally outside Git):

- Batch and all native receipts: `/tmp/omni-workflow-discover-v6-0921-45aba3e/`;
  `batch-progress.json` SHA-256
  `954a64b6ddbd71bd98f89bb55813f849a3b268934c96e3fc1ecaac9c749e203b`.
- Anonymous packets: `/tmp/omni-discover-v6-blind-0921-45aba3e-b/`;
  private arm key: `/tmp/omni-discover-v6-private-0921-45aba3e/arm-key.json`.
- Locked pre-unblind agreement: `/tmp/omni-discover-v6-raters-0921-45aba3e/pre-unblind-agreement.json`,
  SHA-256 `21f1ff2f36aee746f31cd553a24bf34bae745e64ed6f7f1fd846bc2df2c4aae0`.
- Unblinded preliminary paired score:
  `/tmp/omni-discover-v6-raters-0921-45aba3e/unblinded-preliminary-score-v2.json`,
  SHA-256 `25b8a835713a8b57168b20c4ebb4c7f62f45f9d99a5c04ab49e701a9361216e3`.

The post-run packet export guard was adjusted to permit `CLI/G`, which is a
source-evidence channel name rather than a model identity. The scored packets
contain no producer identity text. The local rater launcher wrote a stale
declared prompt hash in its receipts; the actual prompt and both rater copies
match SHA-256 `4a2d2a86218df40de735cc42128424c911eb323092c85e74d640e434c0ea0cd6`.
The discrepancy is preserved in the locked pre-unblind agreement. The
diagnostic CLI launcher cannot independently certify exact Codex model
attribution or invisible provider context. Native receipts showed no external
tool events, but that cannot prove absence of all outside context. This batch
is not a substitute for the separate public Electron/RPC route checks.
