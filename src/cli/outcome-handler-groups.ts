import type { HandlerGroup } from './handler-group-manifest'

// Why split out: the outcome commands grew with conversational waits, and the manifest is at its line limit.
export const OUTCOME_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'outcome',
    keys: [
      'outcome context',
      'outcome commit',
      'outcome attach',
      'outcome audit',
      'outcome ask',
      'outcome wait'
    ],
    load: async () => (await import('./handlers/outcome.js')).OUTCOME_HANDLERS
  }
]
