/** Whether the task DAG has finished, and the stuck-DAG verdict when it can never finish. */
import type { OrchestrationDb } from './db'
import { isDependencyStrandedTask } from './db/tasks/task-dependency-stranding'
import type { TaskRow } from './types'

/** `stuck`: nothing can run, and what remains waits on work that failed. */
export type DagConvergence = 'empty' | 'all-done' | 'active' | 'stuck'

/** Stranded rows plus pending rows a failure never reached (e.g. one settled by restart recovery). */
function strandedTaskIds(tasks: TaskRow[]): Set<string> {
  const failed = new Set(
    tasks.filter((t) => t.status === 'failed' || isDependencyStrandedTask(t)).map((t) => t.id)
  )
  for (let grew = true; grew;) {
    grew = false
    for (const task of tasks) {
      if (
        task.status === 'pending' &&
        !failed.has(task.id) &&
        (JSON.parse(task.deps) as string[]).some((id) => failed.has(id))
      ) {
        failed.add(task.id)
        grew = true
      }
    }
  }
  return new Set([...failed].filter((id) => tasks.find((t) => t.id === id)?.status !== 'failed'))
}

export function evaluateDagConvergence(
  db: OrchestrationDb,
  onLog: (msg: string) => void,
  /**
   * Scope the verdict to one Run. Without it every Run on this machine is folded
   * into one DAG, so a local Run would wait for a stranger's tasks to finish.
   */
  runId?: string
): DagConvergence {
  const tasks = runId ? db.listTasks({ runId }) : db.listTasks()
  if (tasks.length === 0) {
    return 'empty'
  }

  const allDone = tasks.every((t) => t.status === 'completed' || t.status === 'failed')
  if (allDone) {
    return 'all-done'
  }

  const stranded = strandedTaskIds(tasks)
  const active = tasks.filter(
    (t) =>
      (t.status === 'ready' || t.status === 'dispatched' || t.status === 'pending') &&
      !stranded.has(t.id)
  )
  if (active.length > 0) {
    return 'active'
  }
  // Why: a gate-blocked task still waits on a person, so the run is not stuck yet.
  const blocked = tasks.filter((t) => t.status === 'blocked' && !stranded.has(t.id))
  if (blocked.length > 0) {
    onLog(
      `Stuck: ${blocked.length} tasks blocked with no active tasks. Resolve decision gates to continue.`
    )
    return 'active'
  }
  onLog(
    `Stuck: ${stranded.size} task(s) can never start because a dependency failed. Retry the failed task to continue.`
  )
  return 'stuck'
}
