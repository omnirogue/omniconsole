# Quick Discover

One frontier call reads everything in scope at once and lists what it finds; a short second call writes the report. Use it when the code fits in one context window. For larger code, or when results must be checked independently, use Discover.

```sh
omni workflow run --template quick-discover --prompt "Find correctness bugs" --json
```

## What it does

- **Scope.** The workspace's source files, or only the files and folders chosen for the run. In a Git workspace the list comes from `git ls-files --cached --others --exclude-standard`, so `.gitignore` applies. A folder workspace is walked. Either way, dependency, build, cache and dot folders are left out (`node_modules`, `vendor`, `dist`, `build`, `.git` and similar), and so are secrets, lock files, minified files, non-text files and files over 256 KB. Each file goes in under a `--- path ---` header with numbered lines, so results can cite `path:line`.
- **Budget.** Before launch the host estimates the prompt at 3 characters per token, a deliberately low figure so the estimate errs towards refusing. If the estimate is over 60% of the reader seat's context window, the run is refused with a message pointing to Discover. Claude CLI models count as 200k tokens unless the model id ends in `[1m]`, Gemini counts as 1M, and anything else as 200k. To read a scope that needs the 1M window, give the reader the Opus 5.5 (1M context) seat: pick it in the Find step's model picker, or pass `--spec-file` with `{"steps":{"find":{"agents":[{"route":"claude","model":"claude-opus-5-5[1m]"}]}}}`; the refusal message says so when the scope would fit ([LONG-CONTEXT-OPUS-SEAT.md](./LONG-CONTEXT-OPUS-SEAT.md)). The scope is never cut or chunked, because chunked reading measured worse than both options (below). The files are read on this computer, so an SSH workspace is refused.
- **Model.** The reader is the first model family that may judge (Claude Opus by default), and the seat and account come from the normal seat selection. It is one call, not a council.
- **Results.** Each result has a location, a title, a severity, and a detail (trigger, wrong result, quoted code, fix). The app checks each quote against the file, as it does in Discover. In `omni workflow run --json` every result is a review target with `tally: "unverified"` and `singlePass: true`, because no reviewer checked it. The report says the same.
- **JEV verify is not applied.** It runs on a Review step's items, and Quick Discover has no Review step. Its results stay unverified.

## Why (measured 2026-09-27, same scorer)

| Code                                                | Quick (one Opus 5.5 call)                           | Full Discover                                                                     |
| --------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Seeded storefront, 850 lines, 12 bugs               | 9/12 on average, precision 0.60–0.71, ~63 s, ~$0.16 | recall 0.75, precision ~0.30, 41–84 min, 5–10M input tokens                       |
| Python package, 25.8k lines (~513k tokens), 12 bugs | 11/12 and 12/12, precision 1.00, 49–64 s, ~$2.1     | 0/12 and 8/12, 64–69 min, 50–64M input tokens (confounded by a Codex seat outage) |

Chunked reading of the same package did worse: Opus found 7–10/12 at precision ~0.25. The second row needs a 1M-context seat. At the default 200k Claude window, Quick Discover refuses that package.
