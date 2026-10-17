import type { CoreState, CoreStateSetter, Task } from './coreStoreTypes'
import { isOfficeTaskProjection } from './office-task-projection'
import { useUiStore } from './uiStore'

type CoreTaskActions = Pick<
  CoreState,
  | 'addTask'
  | 'removeTask'
  | 'updateTaskStatus'
  | 'submitTaskForReview'
  | 'approveTask'
  | 'rejectTask'
  | 'setTaskOutput'
>

export function createCoreTaskActions(set: CoreStateSetter, uid: () => string): CoreTaskActions {
  return {
    addTask: (task) => {
      const newTask: Task = {
        ...task,
        id: `task_${uid()}`,
        revisions: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      set((s) => ({ tasks: [...s.tasks, newTask] }))
      return newTask
    },

    removeTask: (taskId) => {
      if (isOfficeTaskProjection(taskId)) {
        return
      }
      set((s) => {
        const newTasks = s.tasks.filter((t) => t.id !== taskId)

        // Logic to check if removing this task finishes the project
        const hasRemainingTasks = newTasks.some((t) => t.status !== 'done')
        const isWorking = s.phase === 'working'

        let nextPhase = s.phase
        if (isWorking && !hasRemainingTasks) {
          nextPhase = 'done'
        }

        return {
          tasks: newTasks,
          phase: nextPhase
        }
      })
    },

    updateTaskStatus: (taskId, status) => {
      if (isOfficeTaskProjection(taskId)) {
        return
      }
      set((s) => {
        const task = s.tasks.find((t) => t.id === taskId)
        if (!task) {
          return {}
        }

        // Safety check: Cannot move back to 'in_progress' or 'on_hold' if already 'done'
        if (task.status === 'done' && (status === 'in_progress' || status === 'on_hold')) {
          return {}
        }

        const newTasks = s.tasks.map((t) =>
          t.id === taskId ? { ...t, status, updatedAt: Date.now() } : t
        )

        return {
          tasks: newTasks
        }
      })
    },

    submitTaskForReview: (taskId, draftOutput) => {
      if (isOfficeTaskProjection(taskId)) {
        return
      }
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: 'on_hold',
                draftOutput,
                updatedAt: Date.now()
              }
            : t
        )
      }))
    },

    approveTask: (taskId) => {
      if (isOfficeTaskProjection(taskId)) {
        return
      }
      set((s) => {
        const task = s.tasks.find((t) => t.id === taskId)
        if (task) {
          useUiStore.getState().setAgentStatus(task.assignedAgentId, 'idle')
        }

        return {
          tasks: s.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  status: 'done',
                  output: t.draftOutput || t.output,
                  revisions: t.draftOutput
                    ? [...t.revisions, { output: t.draftOutput, timestamp: Date.now() }]
                    : t.revisions,
                  draftOutput: undefined,
                  updatedAt: Date.now()
                }
              : t
          )
        }
      })
    },

    rejectTask: (taskId, comments) => {
      if (isOfficeTaskProjection(taskId)) {
        return
      }
      set((s) => {
        const task = s.tasks.find((t) => t.id === taskId)
        if (!task) {
          return {}
        }

        useUiStore.getState().setAgentStatus(task.assignedAgentId, 'idle')

        const history = s.agentHistories[task.assignedAgentId] || []
        const updatedHistory = [
          ...history,
          {
            role: 'user' as const,
            content: `Rejected. Reason: ${comments}`
          }
        ]

        return {
          tasks: s.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  status: 'scheduled',
                  reviewComments: comments,
                  revisions: t.draftOutput
                    ? [
                        ...t.revisions,
                        { output: t.draftOutput, feedback: comments, timestamp: Date.now() }
                      ]
                    : t.revisions,
                  draftOutput: undefined,
                  updatedAt: Date.now()
                }
              : t
          ),
          agentHistories: {
            ...s.agentHistories,
            [task.assignedAgentId]: updatedHistory
          }
        }
      })
    },

    setTaskOutput: (taskId, output) => {
      if (isOfficeTaskProjection(taskId)) {
        return
      }
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, output, updatedAt: Date.now() } : t))
      }))
    }
  }
}
