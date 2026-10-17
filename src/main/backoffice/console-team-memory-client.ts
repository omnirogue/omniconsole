import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { teamMemoryStatus, type TeamMemoryStatus } from '../../shared/team-memory-contract'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

/** My own connector's memory state. A read, and the only team-memory route the IDE has. */
export function fetchTeamMemoryStatus(): Promise<ConsoleWorkflowResult<TeamMemoryStatus>> {
  return request('/api/team-memory/status', 'GET', teamMemoryStatus, undefined, 10_000)
}
