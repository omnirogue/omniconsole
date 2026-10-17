# The OmniSI Open-Source Suite

Four open-source projects under [github.com/omnirogue](https://github.com/omnirogue) work together
on your own machine, with your own model keys:

| Project | Repository | Commands | Role |
| --- | --- | --- | --- |
| OmniConsole | [omnirogue/omniconsole](https://github.com/omnirogue/omniconsole) | desktop app, `omni` | Multi-agent IDE: worktrees, terminals, browser, review and orchestration. |
| OmniSeek | [omnirogue/omniseek](https://github.com/omnirogue/omniseek) | `omniseek`, `omniseek-mcp` | Multi-lens codebase discovery and deterministic citation-grounding verification. |
| OmniEvolve | [omnirogue/omnievolve](https://github.com/omnirogue/omnievolve) | `omnievolve`, `omnievolve-mcp` | Evolutionary code and prompt optimization with a local SQLite lineage ledger. |
| JevLab | [omnirogue/jevlab](https://github.com/omnirogue/jevlab) | `jevlab`, `jevlab-mcp` | LLM-as-judge calibration, swap- and length-bias diagnostics and agreement benchmarks. |

OmniConsole's copy of this catalog is
[`src/shared/omnisi-oss-ecosystem.ts`](../../src/shared/omnisi-oss-ecosystem.ts). Change the
catalog there; this page and the README describe it.

## How the pieces connect

OmniConsole runs your coding agents. Each agent reaches the other three projects as local MCP
servers over stdio, and you can call the same functionality from a shell through their CLIs. No
network service or account is involved.

1. **Discover and ground.** An agent asks OmniSeek to map the code relevant to a task, and
   OmniSeek's deterministic verifier checks the files and lines the answer cites, so you review
   grounded answers instead of plausible ones.
2. **Judge.** JevLab calibrates the LLM judges you use against labelled examples and reports
   position-swap and length bias, so a score means the same thing from run to run.
3. **Evolve.** OmniEvolve mutates a prompt or module, scores each candidate with your evaluator
   (for example a JevLab-calibrated judge), keeps the best, and records every candidate, score
   and parent in a local SQLite ledger you can audit.
4. **Review.** The winning change lands in an OmniConsole worktree as an ordinary diff for you
   to annotate, merge or discard.

## Configure the local MCP servers

Install OmniSeek, OmniEvolve and JevLab from their repositories so the `*-mcp` commands are on
your `PATH`, then add them to the MCP configuration your agent reads (`.mcp.json` for Claude
Code, `.cursor/mcp.json` for Cursor, `mcpServers` in Gemini CLI settings):

```json
{
  "mcpServers": {
    "omniseek": { "command": "omniseek-mcp", "args": [] },
    "omnievolve": { "command": "omnievolve-mcp", "args": [] },
    "jevlab": { "command": "jevlab-mcp", "args": [] }
  }
}
```

For Codex, add the same servers to `~/.codex/config.toml`:

```toml
[mcp_servers.omniseek]
command = "omniseek-mcp"

[mcp_servers.omnievolve]
command = "omnievolve-mcp"

[mcp_servers.jevlab]
command = "jevlab-mcp"
```

In code, `getDefaultOmniSiOssMcpServers()` returns these entries as a fresh object you can merge
into an existing configuration. Each server runs with your user's permissions on the machine
that starts it, which for an SSH or WSL workspace is the remote host. Install the tools there
too.

## What OmniSI Cloud adds

OmniSI Cloud is an optional hosted service powered by the proprietary OmniRogue Rust Engine.
The open-source projects never depend on it. `getOmniSiCloudUpgradeCapabilities()` lists each
upgrade next to the open-source capability it extends:

| Capability | Open source, on your machine | With OmniSI Cloud |
| --- | --- | --- |
| Throughput | Agents, evaluations and MCP tools run on your own machines and SSH hosts. | Large evaluation and generation batches run in parallel on the hosted Rust engine. |
| Evolve | OmniEvolve: single-objective search with a local SQLite lineage ledger. | Multi-objective Pareto fronts and novelty search across hosted populations. |
| Judging | JevLab: calibrate and debias the judges you run with your own keys. | A calibrated judge ensemble spanning model families, run as a service. |
| Teams | One person, their own machines and provider accounts. | Shared workspaces, role-based access control, audit and a managed execution fleet. |

To connect, sign in to OmniRogue from OmniConsole, or add the hosted MCP endpoint
`https://app.omnisi.ai/mcp` to any MCP client and complete its authorization flow. See the
[connector guide](OMNIROGUE-CONNECTOR-GUIDE.md) and the
[unified MCP reference](UNIFIED-MCP-REFERENCE.md). The engine itself is not open source and is
not part of this repository.

## Contributing

Each project has its own issues, pull requests and release cycle. Open a change in the repository
that owns the behavior; if it spans projects, open an issue in each and link them. The
OmniConsole process is in the [contributing guide](../../.github/CONTRIBUTING.md).
