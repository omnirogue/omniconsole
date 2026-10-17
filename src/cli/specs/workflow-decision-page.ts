import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKFLOW_DECISION_PAGE_SPECS: CommandSpec[] = [
  {
    path: ['workflow', 'render-page'],
    summary: 'Rebuild Discover decision pages from findings.json without model calls',
    usage: 'omni workflow render-page <findings.json> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    positionalArgs: ['file']
  },
  {
    path: ['workflow', 'page-picks'],
    summary: 'Read every structured pick from a current approved Discover page answer',
    usage: 'omni workflow page-picks <findings.json> --answer <status.json> [--page <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file', 'answer', 'page'],
    positionalArgs: ['file']
  }
]
