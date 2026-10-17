import { validated, requestConsoleWorkflow as request } from './console-workflow-transport'
import { taskRequest } from '../../shared/console-workflow-schemas'
import type { ConsoleWorkflowApi } from '../../shared/console-workflow-types'
import {
  taskDependencyAddAnswer,
  taskDependencyAddRequest,
  taskDependencyGraph,
  taskDependencyRemoveAnswer,
  taskDependencyRemoveRequest
} from '../../shared/task-dependencies-contract'

// Why the hub relay prefix: the console runs its member task check on BOTH tasks there.
const depsPath = (taskId: string) => `/api/gtd/hub/api/collab/board/${taskId}/deps`

export const consoleTaskDependenciesClient: Pick<
  ConsoleWorkflowApi,
  'listTaskDependencies' | 'addTaskDependency' | 'removeTaskDependency'
> = {
  listTaskDependencies: (args) =>
    validated(args, taskRequest, ({ taskId }) =>
      request(
        depsPath(taskId),
        'GET',
        taskDependencyGraph.refine((graph) => graph.task_id === taskId)
      )
    ),
  addTaskDependency: (args) =>
    validated(args, taskDependencyAddRequest, ({ taskId, dependsOnTaskId, condition }) =>
      request(depsPath(taskId), 'POST', taskDependencyAddAnswer(dependsOnTaskId), {
        depends_on_task_id: dependsOnTaskId,
        condition: condition ?? 'DONE'
      })
    ),
  removeTaskDependency: (args) =>
    validated(args, taskDependencyRemoveRequest, ({ taskId, dependsOnTaskId }) =>
      request(`${depsPath(taskId)}/${dependsOnTaskId}`, 'DELETE', taskDependencyRemoveAnswer)
    )
}
