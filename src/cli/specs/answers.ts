import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ANSWERS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['answers', 'pilot-report'],
    summary: 'Summarise the hook-first answer delivery pilot on this computer',
    usage: 'omni answers pilot-report [--since <30m|24h|7d>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since'],
    examples: ['omni answers pilot-report', 'omni answers pilot-report --since 7d --json'],
    notes: [
      'Reads only <userData>/answer-delivery-pilot.jsonl (and its rotated .1); default the last 24 hours. Works with OmniConsole closed.',
      'Shows deliveries by path (hook_stop, hook_post_tool, hook_prompt, hook_session_start, typed_fallback), p50/p95 claim-to-confirmation latency, the fallback rate and items still open.'
    ]
  }
]
