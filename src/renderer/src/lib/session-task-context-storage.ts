import { z } from 'zod'

const STORAGE_KEY = 'omni.pending-session-task-context.v1'
const fenceSchema = z.object({
  accountScope: z.string(),
  sourceKey: z.string(),
  hostId: z.string(),
  sessionKey: z.string(),
  taskId: z.string().optional(),
  hubSessionId: z.string().optional(),
  contextId: z.string().optional()
})
export const pendingSchema = z.object({
  id: z.string(),
  fence: fenceSchema,
  taskId: z.string(),
  sessionId: z.string().optional(),
  packVersion: z.union([z.string(), z.number()]).optional(),
  deliveredVersion: z.union([z.string(), z.number()]).optional(),
  prefix: z.string().max(80_000)
})
type Pending = z.infer<typeof pendingSchema>

export function readPending(): Pending[] {
  try {
    const entries = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(entries)
      ? entries.flatMap((row) => {
          const result = pendingSchema.safeParse(row)
          return result.success
            ? [
                {
                  ...result.data,
                  fence: {
                    ...result.data.fence,
                    taskId: result.data.taskId,
                    hubSessionId: result.data.sessionId,
                    contextId: result.data.id
                  }
                }
              ]
            : []
        })
      : []
  } catch {
    return []
  }
}

export function savePending(entries: Pending[]): boolean {
  if (entries.some((entry) => !pendingSchema.safeParse(entry).success)) {
    return false
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    return true
  } catch {
    return false
  }
}
