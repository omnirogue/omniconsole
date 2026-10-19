import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why: unquoted words arrive as positionals; the handler joins them into one query.
export const SESSION_SEARCH_QUERY_WORDS = ['query', 'word2', 'word3', 'word4', 'word5', 'word6']

export const SESSION_SEARCH_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'search'],
    summary:
      'Find conversations by what was said in them: names, URLs, IDs, paths, PR numbers or a topic, on this computer and every paired host',
    usage: 'omni session search <words…> [--limit <n>] [--local] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...SESSION_SEARCH_QUERY_WORDS, 'limit', 'local'],
    positionalArgs: SESSION_SEARCH_QUERY_WORDS,
    examples: [
      'omni session search Uma',
      'omni session search https://app.omnisi.ai/a/1a0d42a7df36eefc2',
      'omni session search omnirogue production --limit 5',
      'omni session search "side menu" --json'
    ],
    notes: [
      'Matches every Claude and Codex transcript on the host (asks, replies and tool output, with secrets removed), plus each session summary. Words match exactly or by their start; quoted text must appear together. Common abbreviations count as the same word (prod/production, PR/pull request).',
      'Each result says why it matched. Hosts that could not be asked are listed as unreachable, never as having no matches. --local searches only this computer.',
      'Archived (by hand or automatically), exited and closed conversations are all searched. Each result carries ref <agent>:<id>@<host>, which --ref accepts on omni session resume, archive, continue, ask, stop, restart and rename, and lists every sidebar row holding it (pane, state, verdict, archived by hand or automatically, folder). No row means its tab was closed: omni session resume --ref reopens it. --json adds hits[].ref, hits[].sidebar ([] = no row; absent = unknown) and sidebarJoin ({state: joined} or {state: unavailable, reason}).'
    ]
  }
]
