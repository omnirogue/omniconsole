---
name: omni-workspace-create
description: >-
  Create an OmniConsole workspace for a person who is not a developer: a repository
  (cloned from a Git URL or an existing folder, optionally on a new branch) or a plain
  folder of files, with its own AGENTS.md instructions, an agent template to launch
  with, and the files or formats the work needs. Use when someone says "make me a
  workspace", "set up a folder for X with instructions", "new project for the agent",
  "clone this repo and give the agent rules", or asks how a workspace differs from a
  folder.
---

# Create a workspace with its own instructions

A **workspace** is a place an agent works in, registered in OmniConsole so it shows in the
sidebar and the launcher's "In …" row. There are two kinds:

| Kind | What it is | When to use it |
| --- | --- | --- |
| **Repository** | A Git checkout: branches, worktrees, pull requests | Code, anything reviewed through Git |
| **Folder** | A plain directory of files, no Git | Notes, documents, spreadsheets, a company's paperwork |

Both read the workspace's own `AGENTS.md` (and `CLAUDE.md` for Claude Code) at launch.
OpenCode and Local Ollama sessions also read the user's global rules in
`~/.config/opencode/AGENTS.md` (or `$XDG_CONFIG_HOME/opencode/AGENTS.md`), and then the **agent template** chosen in the launcher,
appended last. The template is optional; `Default` adds nothing.

## Steps

1. **Decide the kind.** Ask one question if unclear: "Is this code in a Git repository, or a
   folder of files?" Never create a Git repository for documents just to get instructions;
   a folder reads `AGENTS.md` too.
2. **Create the place.**
   - Repository from a URL: `git clone <url> <parent>/<name>`; for a branch,
     `git -C <parent>/<name> switch -c <branch>`.
   - Repository already on disk: use its path as is.
   - Folder: `mkdir -p <path>`.
3. **Write the instructions** to `<path>/AGENTS.md`. Keep them short and specific: what
   the work is, what "done" means, what must never happen, where outputs go. Do not copy
   the global rules into it; they are read anyway. Prefer Markdown headings and bullets.
4. **Add the files or formats the work needs** (a `templates/` folder, a `README.md`,
   an example output). Say what you created.
5. **Register it in OmniConsole:**
   - Repository: `omni repo add --path <path> --kind git`
   - Folder: `omni repo add --path <path> --kind folder`
   - For a new branch of an already-registered repository, prefer
     `omni worktree create` (see `omni worktree create --help`) so the branch becomes its
     own workspace.
6. **Attach an agent template**, if one fits. Templates live in Settings › AI Capabilities
   › Agents › Agent templates (built-in: Default, Developer, Reviewer, Researcher, plus
   the user's own). Tell the person which one to pick in the launcher's Agent row; the
   launcher remembers the choice per workspace after the first launch. If the work needs
   a template that does not exist yet, write the instructions the person should paste
   into "New template" rather than inventing a file format.
7. **Report** the path, the kind, the instruction file, and the first launch to try:
   `+` → Model → the "In <name>" row → pick the agent → pick any model.

## Rules

- Ask before overwriting an existing `AGENTS.md`; show the diff you intend.
- Never write secrets into instruction files.
- Do not create Conversations sidebar folders (`omni folder create`) for this; those group
  conversations, they are not places on disk.
- Cross-platform: build paths with the shell's own separator; do not assume `/`.
