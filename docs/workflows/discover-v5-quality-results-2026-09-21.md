# Discover v5 quality calibration (2026-09-21)

The six frozen Discover v5 cases ran on clean source HEAD
`16c346407ab81e25ade52a1ccc7f426278992fbd`, with manifest SHA-256
`37e4405f35d010dcae16d5fbebdeff6739b4150073851d6df94538bb222d85e4`.
This evaluated Discover program revision 4. A later review identified a
pre-clustering selection edge case in that revision, so these results are
calibration evidence for the old tree, not a quality claim for revision 5.

| Arm                          | Seeded distinct roots | Confirmed false positives | Duplicates | First-attempt completed |
| ---------------------------- | --------------------: | ------------------------: | ---------: | ----------------------: |
| Discover workflow            |                   4/4 |                         0 |          0 |                     6/6 |
| Claude Sonnet 5, low effort  |                   4/4 |                         0 |          0 |                     6/6 |
| Claude Sonnet 5, high effort |                   4/4 |                         0 |          0 |                     6/6 |

All three arms found the seeded roots in cases 01–03 and returned no confirmed
finding in the three controls. There was no observed quality advantage over
either single-model comparator. The workflow made 33 accepted logical calls
across six cases, with no repairs; the two baselines made one call per case each.
The batch completed in 330.528 seconds. First outcomes were the primary score;
later repair outcomes, had any occurred, would have been separate resilience
evidence. No human adjudication was performed.

Before the arm key was opened, independent Claude and Codex raters reviewed all
18 randomized, model-masked packets. They agreed on packet-level claim support
and duplicates for all 18: 12 supported claims, no duplicates, no missed seeded
roots. This is preliminary model adjudication, not a blind human judgment.

Local QA artifacts:

- Batch and native receipts: `/tmp/omni-workflow-discover-v5-0921-16c3464/`;
  `batch-progress.json` SHA-256
  `5449ce4e7c81e83ae1ce63915cc871f0592333af5fa221f9c1babc5`.
- Blinded packet export: `/tmp/omni-discover-v5-blind-0921-16c3464/`;
  private arm key: `/tmp/omni-discover-v5-private-0921-16c3464/arm-key.json`.
- Corrected preliminary score:
  `/tmp/omni-discover-v5-raters-0921-16c3464/unblinded-preliminary-score-v2.json`,
  SHA-256 `dad8c4f07b5f568b4ad3928e07b5c4b3aba51d5e5f0077fb732b7d313205b466`.

The diagnostic launcher recorded native model receipts and no observed tool
events, but does not certify exact Codex model attribution or invisible provider
context. Sonnet 5 and Grok 4.6 Build appeared in the respective native model
receipts. Published Anthropic token rates estimate about $0.223 for the
workflow's Claude calls and $0.042/$0.045 for the low/high Claude baselines.
Grok 4.6 Build and Codex route billing are unknown here; these are not invoice
costs. A later Grok-only process-timeout increase from 120 to 180 seconds was
not part of the evaluated tree; every v5 call finished within the old cap.
