import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SESSION_QUESTIONS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'questions'],
    summary: 'List the questions sessions on this computer are waiting for you to answer',
    usage: 'omni session questions [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni session questions', 'omni session questions --json'],
    notes: [
      'One entry per pane still waiting on its question (AskUserQuestion or the agent’s equivalent), oldest first. A question answered anywhere (the terminal, Needs you, another tool) is gone from the list.',
      'JSON entries carry paneKey, title, agent, askedAt, toolUseId (Claude’s tool_use_id), sessionId (the provider session) and questions[] with question, header, multiSelect and options[].label.',
      'Answer a single-choice question with `omni session list --state awaiting-user --json` (its ask.fingerprint) and `omni session answer --pane <paneKey> --expect <fingerprint> --choose <n>`; multi-select and free-text answers go through Needs you or the session itself.'
    ]
  }
]
