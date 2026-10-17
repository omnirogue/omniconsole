import { z } from 'zod'

export const workflowFolderWorkspace = z
  .object({
    kind: z.literal('folder'),
    host: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    allocation: z.literal('job')
  })
  .strict()

export const workflowNodeWorkspace = z.union([
  workflowFolderWorkspace,
  z
    .object({
      kind: z.literal('folder'),
      host: z.literal('local'),
      path: z.string().min(1).max(4096)
    })
    .strict()
])

export type ConsoleWorkflowFolderWorkspace = z.infer<typeof workflowFolderWorkspace>
export type ConsoleWorkflowNodeWorkspace = z.infer<typeof workflowNodeWorkspace>
