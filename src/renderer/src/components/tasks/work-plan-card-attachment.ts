import { attachSessionToTask } from './create-task-submit'

/** Bind the existing renderer attach operation for the host poster's injected dependency. */
export function workPlanCardAttachment(
  session: Parameters<typeof attachSessionToTask>[0],
  input: Parameters<typeof attachSessionToTask>[2] = {}
): (taskId: string) => ReturnType<typeof attachSessionToTask> {
  return (taskId) => attachSessionToTask(session, taskId, input)
}
