import type { CommandSpec } from '../command-spec'
import { NEXT_OUTCOME_AGENT_INSTRUCTIONS } from '../../shared/next-outcome-intent-instructions'

export const OUTCOME_SPECS: CommandSpec[] = [
  {
    path: ['outcome', 'attach'],
    summary: 'File an outcome under a task without changing execution',
    usage: 'omni outcome attach --id <chain-id> --task btk_... [--outcome <outcome-id>] --json',
    allowedFlags: ['id', 'task', 'outcome'],
    destructive: true,
    notes: [
      'Requires authenticated user authority; source agents cannot grant themselves task filing authority.'
    ]
  },
  {
    path: ['outcome', 'audit'],
    summary: 'List pursued sessions whose saved record contradicts what it proves',
    usage: 'omni outcome audit [--json]',
    allowedFlags: [],
    notes: [
      'Read-only. Each row names the run, its recorded state, how it reads under the run lifecycle policy, the findings (complete-not-recorded, complete-not-sealed, unclassified-block, state-disagrees-with-phase, stale-attention, disposition-failed) and what the host reconciliation will do. It repairs nothing.'
    ]
  },
  {
    path: ['outcome', 'context'],
    summary: 'Read the current source prompt and editable committed outcome set',
    usage: 'omni outcome context --json',
    allowedFlags: ['dispatch-capability'],
    notes: [NEXT_OUTCOME_AGENT_INSTRUCTIONS]
  },
  {
    path: ['outcome', 'ask'],
    summary: 'Post a wait ask to a staff member on Slack or email through omnios',
    usage: 'omni outcome ask --person <name|emp_id> --via slack|email --text "<the ask>" --json',
    allowedFlags: ['person', 'via', 'text', 'dispatch-capability'],
    destructive: true,
    notes: [
      "A real send. Only when the person's own message names that channel and that staff member; customers are refused. Idempotent per conversation, message, person and channel. Put the returned handle in the wait's event.ref and asked_at in event.since."
    ]
  },
  {
    path: ['outcome', 'wait'],
    summary:
      "Record the person's keep waiting / continue anyway / cancel on a wait, or check a session to wait on",
    usage:
      'omni outcome wait --choice keep-waiting|continue|cancel [--condition <id>] --json | omni outcome wait --on-session <pane|ref> --json',
    allowedFlags: ['choice', 'condition', 'on-session', 'dispatch-capability'],
    destructive: true,
    notes: [
      'Only after the person said it in their latest message ("keep waiting", "continue anyway", "cancel"); never choose for them. Cancel stops the rest of this conversation\'s plan.',
      '--on-session checks another local session (pane key or ref from omni session list) and prints the event {source:"session",match:"result",ref:<pane>} for the wait condition; it files nothing. Refused on a host without session waits, for this conversation itself and for a session on another computer.'
    ]
  },
  {
    path: ['outcome', 'commit'],
    summary: 'Commit source-inferred outcomes or user-authored plan changes',
    usage:
      'omni outcome commit --body-file <path|-> [--id <chain-id>] [--task btk_...] [--supersede <reason>] --json',
    allowedFlags: ['body-file', 'dispatch-capability', 'task', 'supersede', 'id'],
    destructive: true,
    notes: [
      'With --task or --supersede, submit {chain?, expectedRevision?, outcomes, planVersion?}; --id selects a saved chain when chain is omitted. These edits require authenticated user authority. Agent claims remain agent claims.',
      'Use outcome context first. Input is strict JSON {expectedRevision, sourcePrompt, outcomes}. Existing obligations cannot be omitted. A save does not assert success.',
      'When outcome context returns teamPlanning (the user turned on "Plan the team" at launch), the JSON may add an optional team {outcomes: [{outcomeId, steps}]}; the host compiles it exactly as Next does and refuses it without that consent.'
    ]
  }
]
