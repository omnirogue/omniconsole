import { z } from 'zod'
import { ARTIFACT_SLUG_PATTERN } from './artifact-review'

const target = z
  .object({
    artifactSlug: z.string().regex(ARTIFACT_SLUG_PATTERN),
    revision: z.number().int().positive(),
    decisionId: z.string().min(1).max(128),
    repoId: z.string().min(1).max(512),
    baseRef: z.string().min(1).max(256)
  })
  .strict()

export const specPrBatchStartSchema = z
  .object({
    mutationId: z.string().uuid(),
    agent: z.enum(['codex', 'claude']),
    targets: z.tuple([target, target, target, target, target])
  })
  .strict()

export type SpecPrBatchStart = z.infer<typeof specPrBatchStartSchema>
export type SpecPrBatchPhase =
  | 'reserved'
  | 'checking'
  | 'building'
  | 'verifying'
  | 'draft_pr_open'
  | 'waiting'
  | 'unverifiable'
  | 'failed'

export type SpecPrBatchSlot = SpecPrBatchStart['targets'][number] & {
  index: number
  title: string
  sourceSha256: string
  snapshotPath: string
  baseOid: string
  repoPath: string
  repoRemote: string
  taskId?: string
  dispatchId?: string
  worktreeId?: string
  worktreePath?: string
  terminalHandle?: string
  branch?: string
  prNumber?: number
  prUrl?: string
  prCreateAttempted?: boolean
  phase: SpecPrBatchPhase
  reason?: string
}

export type SpecPrBatch = {
  version: 1
  id: string
  mutationId: string
  principal: string
  executionHostId: 'local'
  agent: SpecPrBatchStart['agent']
  coordinatorHandle?: string
  runId?: string
  stopped: boolean
  createdAt: string
  updatedAt: string
  slots: [SpecPrBatchSlot, SpecPrBatchSlot, SpecPrBatchSlot, SpecPrBatchSlot, SpecPrBatchSlot]
}

export function implementationApprovalCoversTarget(
  question: string | undefined,
  repository: string,
  baseRef: string
): boolean {
  const text = question?.toLowerCase() ?? ''
  const repo = repository.replace(/^github\.com\//i, '').toLowerCase()
  return (
    /\bimplement\b/.test(text) &&
    /\bdraft (?:github )?(?:pr|pull request)\b/.test(text) &&
    text.includes(repo) &&
    text.includes(baseRef.toLowerCase())
  )
}

export function verifiedSpecPrCount(batch: SpecPrBatch): number {
  return batch.slots.filter((slot) => slot.phase === 'draft_pr_open' && slot.prUrl).length
}
