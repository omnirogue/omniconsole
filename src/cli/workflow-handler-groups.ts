import type { HandlerGroup } from './handler-group-manifest'

// Why split out: the workflow commands change as a unit, and the manifest is at its line limit.
export const WORKFLOW_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'agents',
    keys: ['agents list', 'agents show', 'agents set', 'agents rm'],
    load: async () => (await import('./handlers/agents.js')).AGENT_TEMPLATE_HANDLERS
  },
  {
    name: 'jev',
    keys: ['jev status', 'jev on', 'jev off', 'jev request'],
    load: async () => (await import('./handlers/jev.js')).JEV_HANDLERS
  },
  {
    name: 'jev-rubrics',
    keys: ['jev rubrics list', 'jev rubrics save', 'jev rubrics evaluate'],
    load: async () => (await import('./handlers/jev-rubrics.js')).JEV_RUBRIC_HANDLERS
  },
  {
    name: 'jev-records',
    keys: ['jev records list', 'jev records export', 'jev outcome'],
    load: async () => (await import('./handlers/jev-records.js')).JEV_RECORD_HANDLERS
  },
  {
    name: 'find-best',
    keys: ['find-best', 'workflow run'],
    load: async () => (await import('./handlers/find-best.js')).FIND_BEST_HANDLERS
  },
  {
    // Read-only: its one command reports the judging record and changes nothing.
    name: 'workflow-stats',
    keys: ['workflow stats'],
    load: async () => (await import('./handlers/workflow-stats.js')).WORKFLOW_STATS_HANDLERS
  },
  {
    name: 'workflow-decision-page',
    keys: ['workflow render-page', 'workflow page-picks'],
    load: async () =>
      (await import('./handlers/workflow-decision-page.js')).WORKFLOW_DECISION_PAGE_HANDLERS
  },
  {
    // Read-only: reports one run by id without resuming it.
    name: 'workflow-status',
    keys: ['workflow status', 'discover deliver'],
    load: async () => (await import('./handlers/workflow-status.js')).WORKFLOW_STATUS_HANDLERS
  }
]
