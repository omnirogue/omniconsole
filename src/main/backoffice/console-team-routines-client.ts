import {
  teamRoutineCreateRequest,
  teamRoutineCreateResponse,
  teamRoutine,
  teamRoutines,
  teamRoutineRequest,
  teamRoutineRuns,
  teamRoutineShareRequest,
  teamRoutineShareResponse,
  type ConsoleTeamRoutinesApi
} from '../../shared/console-team-routines-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

export const consoleTeamRoutinesClient: ConsoleTeamRoutinesApi = {
  list: () => request('/api/routines', 'GET', teamRoutines),
  get: (args) =>
    validated(args, teamRoutineRequest, ({ id }) =>
      request(`/api/routines/${id}`, 'GET', teamRoutine)
    ),
  runs: (args) =>
    validated(args, teamRoutineRequest, ({ id }) =>
      request(`/api/routines/${id}/runs`, 'GET', teamRoutineRuns)
    ),
  share: (args) =>
    validated(args, teamRoutineShareRequest, ({ id, employeeId }) =>
      request(`/api/routines/${id}/share`, 'POST', teamRoutineShareResponse, {
        employee_id: employeeId
      })
    ),
  enable: (args) =>
    validated(args, teamRoutineRequest, ({ id }) =>
      request(`/api/routines/${id}/enable`, 'POST', teamRoutine)
    ),
  disable: (args) =>
    validated(args, teamRoutineRequest, ({ id }) =>
      request(`/api/routines/${id}/disable`, 'POST', teamRoutine)
    ),
  // Local-to-team conversion.
  create: (args) =>
    validated(args, teamRoutineCreateRequest, (body) =>
      request('/api/routines', 'POST', teamRoutineCreateResponse, body)
    )
}
