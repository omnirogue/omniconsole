import { z } from 'zod'

export const localWorkflowLaunchFields = {
  operationId: z.string().uuid().optional(),
  origin: z.enum(['cli', 'benchmark']).optional()
}

/** Persisted with the anchor so a retry keeps its conversation and original request. */
export const localWorkflowLaunchSchema = z.object({
  operationId: z.string().uuid(),
  origin: z.enum(['cli', 'benchmark']),
  request: z.string()
})

export type LocalWorkflowLaunch = z.infer<typeof localWorkflowLaunchSchema>
