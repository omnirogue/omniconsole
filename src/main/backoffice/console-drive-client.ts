import {
  consoleCardDrive,
  consoleDriveFileRequest,
  consoleDriveIntake,
  consoleDriveIntakes,
  type ConsoleDriveApi
} from '../../shared/console-drive-contract'
import { taskRequest } from '../../shared/console-workflow-schemas'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { failure, requestConsoleWorkflow as request, validated } from './console-workflow-transport'

const path = (id: string) => `/api/gtd/hub/api/board/${id}/drive`
const DRIVE_WRITE_TIMEOUT = 120_000

export const consoleDriveClient: ConsoleDriveApi = {
  get: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        path(taskId),
        'GET',
        consoleCardDrive.refine((value) => value.task_id === taskId)
      )
    ),
  intakes: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        `${path(taskId)}/intakes`,
        'GET',
        consoleDriveIntakes.refine(
          (value) =>
            value.task_id === taskId && value.intakes.every((intake) => intake.task_id === taskId)
        )
      )
    ),
  declare: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        `${path(taskId)}/declare`,
        'POST',
        consoleCardDrive.refine((value) => value.task_id === taskId && value.declared),
        {},
        DRIVE_WRITE_TIMEOUT
      )
    ),
  requestFiles: (args) =>
    validated(args, consoleDriveFileRequest, async (input) => {
      const captured = await captureConsoleWorkflowPerson()
      if (!captured.ok) {
        return captured
      }
      const { principal, isCurrent } = captured.data
      const destination = await request(
        path(input.taskId),
        'GET',
        consoleCardDrive.refine((value) => value.task_id === input.taskId),
        undefined,
        15_000,
        false,
        principal,
        isCurrent
      )
      if (!destination.ok) {
        return destination
      }
      if (!destination.data.supports_project_intake_precondition) {
        return failure(
          'capability_unavailable',
          'File requests are not available on this server yet.'
        )
      }
      if (
        destination.data.destination.scope !== 'project' ||
        destination.data.destination.scope_key !== input.expectedScopeKey
      ) {
        return failure(
          'drive_scope_changed',
          'Refresh the Drive folder before requesting files. File requests require a project folder.'
        )
      }
      // Intake creation has no idempotency key: send once, then reconcile through reads.
      const created = await request(
        `${path(input.taskId)}/intakes`,
        'POST',
        consoleDriveIntake.refine(
          (value) => value.task_id === input.taskId && value.expected_from === input.expected_from
        ),
        {
          expected_from: input.expected_from,
          pattern: input.pattern,
          ...(input.expected_count === undefined ? {} : { expected_count: input.expected_count }),
          share_role: 'writer',
          expected_scope_key: input.expectedScopeKey
        },
        DRIVE_WRITE_TIMEOUT,
        false,
        principal,
        isCurrent
      )
      if (!created.ok) {
        return created
      }
      if (
        created.data.destination?.scope !== 'project' ||
        created.data.destination.scope_key !== input.expectedScopeKey
      ) {
        return failure(
          'drive_scope_unverified',
          `Google may have shared ${created.data.destination?.display ?? 'a folder whose scope was not reported'}. Check access at ${created.data.folder_link} before starting another request.`
        )
      }
      return created
    })
}
