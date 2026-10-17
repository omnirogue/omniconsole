import { GLOBAL_FLAGS, type CommandSpec } from '../args'

const FLAGS = [...GLOBAL_FLAGS, 'reason', 'request', 'dry-run']
// A move to another computer: a new conversation there from the brief; the source stays here.
const HOST_NOTES = [
  '--host ssh:<id> (from omni host list) starts the new target on that computer instead; the target must be new. It is a handoff, not relocation: the source conversation stays on this computer and is archived here only after the new session accepts; moving the same conversation is a later phase. Paired OmniConsole hosts (runtime:<id>) are refused for now.',
  'Before asking for the brief, each git source must have its branch pushed: uncommitted files, commits missing from its upstream or a branch never pushed make the command ask that source (through session ask) to commit and push its branch, then read git again, and refuse with the push command if anything is still unpushed. It never commits or pushes itself. A detached HEAD is refused.',
  'The work continues in an existing workspace of the same repository on that host: the one with the source branch checked out, or --workspace <selector>. None, several, or one with open sessions is refused with the exact omni worktree create command, or the app step that sets the project up on that host. A folder workspace needs --workspace.',
  'The new session starts through the same launch as omni session launch (host-owned account, Claude or Codex) with the brief, branch, commit and acceptance line as its first prompt, is filed in the first source’s folder, and has up to 10 minutes to fetch the branch and accept. An unreachable host is reported unverifiable (host.verdict) and nothing is archived; a new session there may still be running. It never provisions, rents or connects a computer.'
]
const NOTES = [
  'Only the local CLI may act; the acting session is verified from pane launch evidence, just as for session continue and ask. --reason and --request (the person’s words) are recorded with the actor in session-actions.jsonl, once per applied step and once for the final result.',
  'Sources must be positively idle or waiting-for-yes, live, unarchived, on this computer, with their agent’s own process holding the terminal, and different from the caller and target. Working, queued, provider-limited, awaiting-user, exited, unknown and unverifiable sources, and SSH or paired-host sessions, are refused with their reason.',
  'Ask each source through session ask (its own question id), deliver the brief through continue --prompt (its own brief id, the Keep going hard stops on the whole brief), both bound to the agent process, and wait for the finished turn answering that id. Nothing is archived before the target’s complete finished reply is exactly the acceptance line in that brief. Overlapping transfers and changed conversation/process identities are refused.',
  'Failures before archival leave sources unarchived. A lost archive reply triggers a durable receipt read; archiveOutcome is unknown if that cannot confirm the result. Inspect the sources before retrying an unknown result. A brief already delivered stays sent, and the failed step and everything already changed are reported and audited.',
  'Each answer and acknowledgement waits up to 5 minutes. A still-queued prompt is withdrawn on timeout; delivered text cannot be taken back. A new conversation remains available if a later step fails.',
  'new uses the first source’s workspace (git or folder), agent kind and sidebar folder, and waits until the new agent’s own process holds its terminal before delivering. Fresh-session startup evidence is required for a new target (currently Claude and Codex).',
  '--dry-run validates and lists the sources, target and steps. It asks nothing, creates nothing, archives nothing and writes no audit lines. --json includes outcome, sources, target, skipped, steps, failedStep, failure, briefSent, acknowledgement, applied, archived and archiveOutcome. Failures exit non-zero.',
  ...HOST_NOTES
]

export const SESSION_TRANSFER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'handoff'],
    summary: 'Hand work to another conversation, then archive the source after acknowledgement',
    usage:
      'omni session handoff (--pane <key> | --terminal <handle>) --to (<paneKey> | new) [--host ssh:<id> [--workspace <selector>]] [--note "<text>"] [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [...FLAGS, 'pane', 'terminal', 'to', 'note', 'host', 'workspace'],
    examples: [
      'omni session handoff --pane tab-1:leaf-1 --to new --note "Start with the parser fix" --dry-run',
      'omni session handoff --pane tab-1:leaf-1 --to new --host ssh:mw0002 --reason "Needs the build box" --dry-run --json',
      'omni session handoff --terminal term_abc123 --to tab-2:leaf-2 --reason "Continue in the other session" --json'
    ],
    notes: [
      'The existing target must be idle and pass continue --prompt’s conversation checks: its whole latest reply is read, with no open proposal, question or hard stop. A new target is named "<source title> (continued)". The optional note follows the source’s handoff brief. Only after acknowledgement is the source archived with reason "handed off to <target title>".',
      ...NOTES
    ]
  },
  {
    path: ['session', 'consolidate'],
    summary:
      'Combine session briefs into one conversation and archive sources after acknowledgement',
    usage:
      'omni session consolidate --panes <key,key,...> --into (<paneKey> | new) [--host ssh:<id> [--workspace <selector>]] [--skip-busy] [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [...FLAGS, 'panes', 'into', 'skip-busy', 'host', 'workspace'],
    examples: [
      'omni session consolidate --panes tab-1:leaf-1,tab-2:leaf-2 --into new --dry-run',
      'omni session consolidate --panes tab-1:leaf-1,tab-2:leaf-2,tab-3:leaf-3 --into tab-4:leaf-4 --skip-busy --json'
    ],
    notes: [
      'Name 2–50 distinct sources. By default any ineligible source refuses the whole command before asking anyone. --skip-busy reports and skips ineligible sources; at least two eligible sources must remain. The existing target must be idle and pass continue --prompt’s full-reply, no-open-proposal, no-question and no-hard-stop checks.',
      'Ask sources one at a time, put each summary under its title, and ask the target to identify overlaps or conflicts before acting. A new target is named "Consolidated: <first title> +N". After acknowledgement all sources are archived together with reason "consolidated into <target title>"; never deleted.',
      ...NOTES
    ]
  }
]
