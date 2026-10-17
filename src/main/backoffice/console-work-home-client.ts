import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { validated, requestConsoleWorkflow as request } from './console-workflow-transport'
import { taskRequest } from '../../shared/console-workflow-schemas'
import type { ConsoleWorkflowApi } from '../../shared/console-workflow-types'
import { z } from 'zod'
import {
  workBoard,
  workFolders,
  workEvent,
  workNoteRequest,
  workLifecycle,
  workSessions
} from '../../shared/console-work-home-contract'

export const consoleWorkHomeClient: Pick<
  ConsoleWorkflowApi,
  | 'attachWorkSession'
  | 'listWork'
  | 'listTaskActivity'
  | 'addTaskNote'
  | 'getTaskLifecycle'
  | 'listWorkSessions'
> = {
  attachWorkSession: (args) =>
    validated(
      args,
      z
        .object({
          sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,128}$/),
          taskId: taskRequest.shape.taskId
        })
        .strict(),
      ({ sessionId, taskId }) =>
        request(
          `/api/gtd/hub/api/sessions/${sessionId}/attach`,
          'POST',
          z.object({
            session_id: z.literal(sessionId),
            board_task_id: z.literal(taskId),
            changed: z.boolean()
          }),
          { board_task_id: taskId }
        )
    ),
  listWork: async () => {
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok) {
      return person
    }
    const board = await request(
      '/api/work/board-all',
      'GET',
      workBoard,
      undefined,
      15_000,
      false,
      person.data.principal,
      undefined,
      undefined,
      { 'Cache-Control': 'no-cache' }
    )
    if (!board.ok) {
      return board
    }
    const folders = await request(
      '/api/work/folders',
      'GET',
      workFolders,
      undefined,
      15_000,
      false,
      person.data.principal
    )
    if (
      !folders.ok &&
      ['connection_changed', 'principal_mismatch', 'signed_in_required'].includes(
        folders.error.code
      )
    ) {
      return folders
    }
    return {
      ok: true,
      data: {
        ...board.data,
        ...(folders.ok ? { companies: folders.data.companies } : { filingUnavailable: true })
      }
    }
  },
  listTaskActivity: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        `/api/gtd/hub/api/team/tasks/${taskId}/events`,
        'GET',
        z.array(workEvent).refine((events) => events.every((event) => event.task_id === taskId))
      )
    ),
  addTaskNote: (args) =>
    validated(args, workNoteRequest, ({ taskId, note }) =>
      request(
        `/api/gtd/hub/api/team/tasks/${taskId}/comment`,
        'POST',
        workEvent.refine((event) => event.task_id === taskId && event.event === 'comment'),
        {
          note
        }
      )
    ),
  getTaskLifecycle: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        `/api/board/${taskId}/lifecycle`,
        'GET',
        workLifecycle.refine((value) => value.task.id === taskId)
      )
    ),
  listWorkSessions: () => request('/api/sessions', 'GET', workSessions)
}
