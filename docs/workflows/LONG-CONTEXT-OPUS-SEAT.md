# 1M-context Opus workflow seat (2026-09-27)

Claude workflow seats offer **Opus 5.5 (1M context)** next to the default Opus and Sonnet, so one
call can read a large codebase (measured: one Opus call over a ~513k-token package found 11-12 of
12 seeded bugs at precision 1.00 in about a minute).

- **Id:** `claude-opus-5-5[1m]`, the exact id, not the drifting `opus[1m]` alias. It is both the
  picker id and the frozen seat model, and goes to `--model` as is. On CLI 2.1.283 the result's
  `modelUsage` key is this exact string, which the run's model check requires.
- **Not the default.** The default seat stays `opus` → `claude-opus-5`; runs admitted earlier
  replay unchanged (policy revisions do not cover the model list; the argv snapshot uses a
  placeholder model).
- **Choosing it:** the graph editor's model picker next to the Claude family, or a spec model:
  `omni workflow run --template discover --spec-file f.json` with
  `{"steps":{"find":{"agents":[{"route":"claude","model":"claude-opus-5-5[1m]"}]}}}`.
- **Effort** comes from the `opus` session model (default `high`, no ultracode).
- **Context window:** `workflowModelContextTokens` (`src/shared/workflow-model-context-window.ts`,
  moved there from Quick Discover's budget file) returns 1M for a Claude id ending in `[1m]`, 200k
  for other Claude ids. The CLI's reported `contextWindow` is 1M for plain ids too, so only the
  suffix tells the variants apart.
- **Quick Discover** budgets the reader seat by that helper: 600k tokens on this seat against 120k
  on default Opus. A refusal on a Claude 200k seat names this seat when the scope would fit.
- **Label:** "Claude Opus 5.5 (1M context)" in run views and council seat names.
- **Cost:** usage pricing maps it (with or without `[1m]`) to the Opus 5.5 row: $4 input /
  $20 output / $0.20 cache read per million tokens. A 1M seat reads far larger prompts, and
  workflow calls record cost as unknown.
- **Account entitlement** is not probed per account: a plan without 1M context fails at launch
  with the provider's error.
