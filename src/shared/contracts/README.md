# Pinned contracts

Exact copies of wire contracts shared with the hub, OmniConsole and OmniRogue. Do not edit these files
here, and never change a fixture to make a parser pass: change the canonical source, then copy the
new bytes in.

| Contract               | Canonical source                           | Pinned at                   | Lock                           |
| ---------------------- | ------------------------------------------ | --------------------------- | ------------------------------ |
| agent-communication v1 | `omnirogue/omniconsole` `contracts/` | hub `main` at `199fdec38ea` | `agent-communication.lock.json` |

The bytes are identical to their origin, `omnirogue/omniconsole` `docs/contracts` at `1e9a3e0f`. The
pin names the hub because that origin commit exists only on an unmerged branch there.

To update, copy each file from the hub at the new tag or commit:

```sh
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/omnirogue/omniconsole/contents/contracts/agent-communication-v1.schema.json?ref=<ref>"
```

Then set the lock's `tag`, `commit` and digests, and run
`pnpm test src/shared/agent-communication-capabilities.test.ts`. The test fails on any byte that
differs from the lock and runs every shared fixture through the IDE's parser.
