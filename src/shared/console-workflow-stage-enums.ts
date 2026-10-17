import { z } from 'zod'
export const workflowMode = z.enum(['single_shot', 'sequential', 'parallel', 'hybrid'])
export const workflowActor = z.enum(['ai', 'human', 'mechanical'])
export const workflowAction = z.enum([
  'execute',
  'review',
  'repair',
  'approve',
  'decide',
  'check',
  'notify'
])
