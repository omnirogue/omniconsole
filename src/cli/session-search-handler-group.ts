import type { HandlerGroup } from './handler-group-manifest'

export const SESSION_SEARCH_HANDLER_GROUP: HandlerGroup = {
  name: 'session-search',
  keys: ['session search'],
  load: async () => (await import('./handlers/session-search.js')).SESSION_SEARCH_HANDLERS
}

export const SESSION_REUSE_HANDLER_GROUP: HandlerGroup = {
  name: 'session-reuse',
  keys: ['session resume', 'session pending'],
  load: async () => (await import('./handlers/session-reuse.js')).SESSION_REUSE_HANDLERS
}
