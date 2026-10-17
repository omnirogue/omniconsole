# Local Ollama launches and agent templates

The Model menu's **Local Ollama** row starts OpenCode on a model served by a local Ollama
server, with an optional **agent template** layered on the workspace's own instructions.
This page records the contract so the route stays reliable when either tool changes.

## What a launch does

1. The renderer resolves the pick: the workspace target (a worktree or folder workspace key,
   or `*` for the Work root), the template, and the model. Resolution order for the model is
   what that target used last, then the template's preferred model, then the first installed
   model (`resolveLocalOllamaPick` in `src/shared/local-ollama-launch.ts`). A remembered model
   that is no longer installed is kept and shown as "not installed" so the person can pull it;
   it is never swapped silently.
2. `localOllama:prepareLaunch` (main) builds the config OpenCode needs: the Ollama provider
   with exactly that model and, unless the template is `Default`, the template text as an
   `instructions` file (`buildOpenCodeLaunchConfig`). The text is written to
   `<userData>/opencode-agent-templates/omni-<template id>-<sha256 prefix of the text>.md`,
   once per distinct text and never rewritten or pruned (OpenCode re-reads instruction files
   at every step and daemon-owned sessions outlive the app, so a file a session names must
   stay as it was; an edited template simply gets a new file) and the config names that path (on Windows also its `/mnt/<drive>/…` form, so a WSL launch finds it; OpenCode
   skips a path it cannot read). The config itself travels inline as `OPENCODE_CONFIG_CONTENT`
   in the launch env, so a user's own `OPENCODE_CONFIG` stays in force. No agent is declared
   and the session runs as OpenCode's ordinary `build` agent: an agent `prompt` *replaces* the
   built-in system prompt
   (`packages/opencode/src/session/llm/request.ts`, `input.agent.prompt ? [prompt] :
   SystemPrompt.provider(model)`), whereas `instructions` are appended after the global and
   project rules files (`session/instruction.ts`, `config.instructions` paths are read last),
   which is the layering the templates promise. An unknown agent name would also get
   OpenCode's deny-by-default permissions (`agent/agent.ts`, built from `defaults`, not
   `build`), which is the second reason no `omni-<id>` agent is declared.
3. The terminal launches `opencode` with `--model ollama/<tag>` (from the OpenCode option
   catalog). The view is forced to terminal
   because the ACP chat path drops argv. The row renders only when OpenCode is detected as
   usable for that target, like every other provider row.
4. The pick is saved to `settings.launchContextMemory[<target key>]` before launching.

## Why inline config, not the user's config

OpenCode merges config in this order: global `~/.config/opencode/opencode.json`, then the
`OPENCODE_CONFIG` file, then the project's `opencode.json` and `.opencode/`, then
`OPENCODE_CONFIG_CONTENT` ([config docs](https://opencode.ai/docs/config/), fetched
2026-09-29). Passing the launch config inline means the user's own providers, agents, keymaps
and `AGENTS.md` discovery stay untouched. The template file is rewritten per launch, so a
running session keeps the text it started with. The app already sets `OPENCODE_CONFIG_DIR` for its status plugin
(`src/main/opencode/hook-service.ts`); that is a different variable and is not affected.

Global rules: OpenCode reads the first existing file of `$XDG_CONFIG_HOME/opencode/AGENTS.md`
(`~/.config` when unset, per xdg-basedir; the app resolves it the same way) and
`~/.claude/CLAUDE.md` (`session/instruction.ts`, `globalFiles`, first match wins). The
Instruction files pane says which one is in force while the OpenCode file is absent, and
creating the OpenCode file takes over from the Claude one.

## Ollama facts the code depends on

- Inventory: `GET <base>/api/tags`; pull: `POST <base>/api/pull` with an NDJSON stream ending
  in `{"status":"success"}`. Default base URL `http://localhost:11434`.
- OpenCode's provider entry uses `@ai-sdk/openai-compatible` against `<base>/v1`
  ([Ollama's OpenCode guide](https://docs.ollama.com/integrations/opencode)). Before launch,
  the host reads `/api/ps` for the selected model's effective context, or `/api/show` for an
  explicit Modelfile `num_ctx`, bounded by native capacity when available. Native capacity
  alone does not establish the runner's window. Unknown metadata leaves the user's OpenCode
  model context unchanged; the launcher never fabricates a 64k minimum or loads a model to
  probe it. Ollama's own context remains a server setting.
- Local Ollama launches set `compaction.auto: false`. A fixed system/tool prompt can already
  exceed a context budget, so automatic compact-and-continue can otherwise repeat forever.
  OpenCode 1.18.34 stops on a provider context overflow with this setting. Longer chats
  require manual compaction; this setting does not change global OpenCode configuration.
- Loss of contact is reported as `disconnected` with the reason, never as "no models".

## Agent templates

`src/shared/agent-templates.ts` owns the schema: four built-ins (`default`, `developer`,
`reviewer`, `researcher`), overrides for built-ins (never for `default`, which must stay
empty), and custom templates. Ids are slugs safe for OpenCode agent names and file names.
Settings › AI Capabilities › Agents edits them (`AgentTemplatesSetting.tsx`).

Templates are runner-independent text. The Local Ollama route delivers them as an OpenCode
agent. Every other provider row (Claude, Codex, Kimi, Grok, Gemini) receives the template as
the opening message, submitted once the TUI is ready (`LaunchPick.opening`, built by
`withLaunchTemplate`). Two routes cannot carry it and say so with a toast instead of
dropping it silently: custom-model (OMP) launches, which start through the runtime RPC, and
launches reserved while agent availability is still loading.

The choice is remembered per target in `settings.launchContextMemory`, keyed by the launch
target's worktree id, `folder:<id>` for a folder workspace, or `*` for the Work root; each
entry holds `templateId` and, for Local Ollama, `ollamaModel`.

## Workspace vs folder

A workspace key is `worktree:<id>` (a Git worktree of a registered repo) or `folder:<id>`
(a plain folder workspace); see `src/shared/workspace-scope.ts`. The launcher's target column
lists both kinds on the local host and offers "New workspace…" (the existing composer) and "Add a
project…" (the existing Add repo dialog). The bundled `omni-workspace-create` skill walks a
non-developer through creating either kind with its own `AGENTS.md`.
