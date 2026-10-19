import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { AGENT_TEMPLATE_LAUNCH_NOTE, TITLE_ORIGIN_NOTE } from './terminal-title-specs'

export const SESSION_LAUNCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'launch'],
    summary:
      "Launch Claude or Codex on any computer with that computer's verified account capacity",
    usage:
      'omni session launch --provider claude|codex (--prompt-file <path|-> | --prompt "<text>" | --contract <json|->) [--worktree <selector> | --project <name|id> [--name <worktree name>]] [--host <computer>|auto] [--model <model>] [--effort <effort>] [--title <title>] [--title-origin yours|generated|unknown] [--folder <id|path>] [--agent-args <flags>] [--agent-template <id>] [--ephemeral] [--again] [--dry-run] [--json] [--operation-id <id> [--controller-runtime-id <uuid>]]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'worktree',
      'host',
      'controller-runtime-id',
      'provider',
      'model',
      'effort',
      'prompt',
      'prompt-file',
      'contract',
      'operation-id',
      'title',
      'title-origin',
      'folder',
      'agent-args',
      'managed-tools-file',
      'agent-template',
      'ephemeral',
      'again',
      'dry-run',
      'project',
      'name'
    ],
    examples: [
      'omni session launch --provider codex --prompt-file /tmp/brief.md --json',
      'omni session launch --provider codex --worktree id:<worktree.id> --model gpt-5.5 --effort xhigh --prompt-file /tmp/brief.md --title "Workflow audit" --title-origin generated --json',
      `omni session launch --provider claude --host "Mac Studio" --worktree path:/Users/maintainer/Work/OmniRogue --prompt "Summarize today's ad-spend anomalies and draft pauses; do not apply them." --json`,
      'omni session launch --provider claude --host mw0002 --worktree id:<its worktree id> --prompt-file brief.md --dry-run --json',
      'omni session launch --provider claude --project github:omnirogue/omni-ide --prompt-file brief.md --title "Fix login timeout" --json',
      'omni session launch --provider codex --project omni-ide --prompt-file brief.md --dry-run',
      'omni session launch --provider claude --contract contract.json --title "Fix login timeout" --json',
      `omni session launch --provider claude --prompt-file /tmp/brief.md --agent-args '--dangerously-skip-permissions --append-system-prompt "Role: reviewer. Report findings; do not edit files." --disallowedTools Write Edit'`
    ],
    notes: [
      'Inspect existing sessions and prior outputs before launching (omni session find-owner). Reuse an existing owner where suitable. This command starts new work; it does not transfer a conversation.',
      'Only --provider and the brief are required. --worktree defaults to the workspace containing the current directory on this computer. --host defaults to the computer that holds that workspace; given, it is an assertion. --host takes any name from omni host list (a paired computer or an SSH target, plus local, "this computer", "this mac" or "this machine"); do not choose between --environment and ssh: yourself.',
      "--project <name|id> lets OmniConsole pick the computer (--host auto says the same): it reads this computer, every paired computer and this computer's SSH setups of that project read-only (three at a time, 45 s overall), keeps those that advertise agent-session.verified-account-launch.v1, have a ready setup, a verified account and are not hot, and ranks by load band (ok, offload, unknown), then 10-point headroom buckets, then this computer, then paired before SSH, then name. A computer that does not answer is unverifiable, never idle; there is no fallback to this computer. A git project gets a fresh worktree there from the repo default base (--name, else from --title or the brief, plus the operation id's last 6 characters), created once even across retries; your branch and uncommitted or unpushed work do not travel. Its setup script runs beside the agent (like --setup run); a repository whose setupAgentStartupPolicy is wait-for-setup is refused (launch_setup_first, nothing sent) with the omni worktree create --setup run --agent command to use instead. A folder project launches into the shared folder. --host <name> next to --project keeps it on that computer. --project cannot take --worktree (a worktree already fixes the computer), --environment, --folder, --agent-template or --operation-id. The pick is frozen in the launch record: re-running the same command retries there and never re-ranks; after a refusal it names the runner-up's command and any worktree it created (with its omni worktree rm command) and stops. --dry-run shows the ranked computers and the pick, and creates nothing; once this command has frozen a pick it shows that pick without reading any computer, since the real re-run follows it (add --again to preview a fresh placement).",
      'The computer that runs the session picks its account with the most fresh verified capacity (a reading at most 60 s old) and pins it. Unknown or stale capacity refuses with the reason and "Nothing launched"; there is no fallback to an unverified or controller account, and no terminal.create fallback.',
      'Omit --model and --effort unless the person asked: that computer\'s defaults apply and the receipt names them. --effort is checked against this OmniConsole\'s model catalog only for models it knows. Pass the brief with --prompt-file <path>, --prompt-file - (stdin) or --prompt "<text>"; it is read on the invoking computer, non-empty and at most 256 KiB.',
      'Re-running the identical command is the retry: it reuses the recorded operation and resends the same request, so it never starts a second session ("already launched" when one was created). Run it again after a timeout, a killed CLI or a fixed refusal. Add --again only to start a deliberate second copy; to retry a launch started with --again, run it again without --again, because each --again run starts another copy. The operation id is printed to stderr before the send and returned in every result and error.',
      'Records live under <userData>/agent-launch-operations on the invoking computer. --operation-id and --controller-runtime-id are optional and kept for existing callers: an --operation-id without a record also needs the --controller-runtime-id recorded with it.',
      'The receipt names the computer, the account, its % left and reading age, the effective model and effort, and where the session is visible. It proves the terminal was created, not that the provider started; verify that separately.',
      '--dry-run contacts that computer read-only and shows the workspace, the account it would pick and everything the session would get (the same list the desktop launch panel shows); it records and launches nothing and exits 0 even when the launch would refuse (result.wouldRefuse). A preview is not a reservation.',
      '--agent-args replaces the provider flags the host would add by default (for Claude that includes --dangerously-skip-permissions), so pass the complete set, quoted for a POSIX shell on the host. Model and effort from --model and --effort are still added unless the args already carry them.',
      'In a project (--folder naming a project folder, or a folder inside one) the session inherits the project settings as the desktop launcher does: a "Project: <name>" line, the project default agent (or its copy of --agent-template), a one-line pointer to omni folder project naming the project agents usable as subagents, then its brief, repos, docs, files and skills resolved for the executing host. Items the host lacks are listed and left out.',
      '--contract <path|-> takes the fields of the implement task template as one JSON object (objective, owner, host, branch, scope, acceptance one check per line, evidence; optional outOfScope and context) and renders the brief from them, numbering Acceptance A1, A2, … and asking for one "A1 PASS|FAIL — …" line per item at the end. On the host that runs it, the session then gets a verify step: when its first turn ends, a separate seat re-runs every Acceptance line, only passed lines count, and a failure stops for the owner with the failing lines. The command waits for that binding (up to 4 minutes, while the session starts its first turn); a lost answer is retried by running the same command again, which never launches a second session. At most 32 Acceptance checks; an incomplete contract is refused and nothing launches. Any work qualifies, in a repository or a plain folder: the verify seat judges what it can observe, wherever the work landed. It works from any terminal or agent that can run omni: Claude, Codex, Omnigent or a plain shell.',
      '--ephemeral arms When finished: End on the new session, the choice a person can pick: its window closes the tab once the executing host confirms the work finished and nothing is queued, proposed, held or awaited, and never closes a pinned tab. A re-run of the same command arms it again if an earlier run was interrupted. A host without agentSession.scheduleFinish ignores the flag without a warning, so the session then stays open.',
      TITLE_ORIGIN_NOTE,
      AGENT_TEMPLATE_LAUNCH_NOTE,
      "Local launches adopt their terminal into this computer's sidebar without selecting a workspace or tab; a launch on a paired computer stays in the background in that computer's sidebar (omni session list --environment <name>). If the desktop is unavailable, keep the returned terminal handle and reveal it later; never relaunch to repair visibility. --folder and --agent-template need this computer as the controller. Filing or title failures are returned beside the created terminal and must not trigger another launch."
    ]
  },
  {
    path: ['session', 'launch-inspect'],
    summary: 'Verify the original managed launch process and provider conversation.',
    usage: 'omni session launch-inspect --operation-id <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'operation-id'],
    examples: ['omni session launch-inspect --operation-id <id> --json'],
    notes: [
      'Run on the execution host. A replaced terminal or restarted runtime is unverifiable; the command never adopts its current process.'
    ]
  }
]
