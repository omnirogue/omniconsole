import { z } from 'zod'
import { computeBriefContentHash } from './assisted-brief-hash'
import {
  ASSISTED_BRIEF_LIMITS as LIMITS,
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord
} from './assisted-brief-types'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

const id = z.string().min(1).max(80)
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const workspaceKey = z.string().min(1).max(1024)
const origin = z.enum([
  'request',
  'answer',
  'person',
  'ai-assumption',
  'ai-suggestion',
  'challenge'
])
const item = z.object({ id, text: z.string().min(1).max(LIMITS.itemChars), origin })
const items = z.array(item).max(LIMITS.itemsPerSection)
const section = z.enum(BRIEF_LIST_SECTIONS)
const content = z.object({
  outcome: item,
  sections: z.object({
    scope: items,
    constraints: items,
    assumptions: items,
    deliverables: items,
    successChecks: items
  }),
  questions: z
    .array(
      z.object({
        id,
        prompt: z.string().min(1).max(300),
        choices: z.array(z.string().min(1).max(120)).max(LIMITS.choicesPerQuestion),
        section
      })
    )
    .max(LIMITS.questions)
})
const actor = z.object({
  agent: z.custom<TuiAgent>((value) => isTuiAgent(value)),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(40).optional(),
  accountChoiceId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(80)
})
const revisionNumber = z.number().int().positive()
const revision = z.object({
  number: revisionNumber,
  cause: z.enum([
    'drafted',
    'edited',
    'added',
    'answered',
    'removed',
    'challenge-applied',
    'workspace-changed'
  ]),
  createdAt: z.number(),
  content,
  contentHash: hash
})
const start = z.object({
  operationId: z.string().min(1).max(200),
  tabId: z.string().min(1).max(80),
  launchedTabId: z.string().min(1).max(200).nullable(),
  revision: revisionNumber,
  contentHash: hash,
  workspaceKey,
  favoriteId: z.string().min(1).max(80),
  status: z.enum(['starting', 'started', 'not-started', 'unconfirmed']),
  verifiable: z.boolean(),
  requestedAt: z.number(),
  settledAt: z.number().optional(),
  failure: z.enum(['blocked', 'repeat', 'launch-failed', 'released']).optional()
})
const finding = z.object({
  id,
  kind: z.enum([
    'missed-requirement',
    'unsupported-assumption',
    'unnecessary-work',
    'regression-risk'
  ]),
  note: z.string().min(1).max(400),
  change: z.discriminatedUnion('action', [
    z.object({ action: z.literal('add'), section, text: z.string().min(1).max(LIMITS.itemChars) }),
    z.object({ action: z.literal('remove'), targetItemId: id }),
    z.object({ action: z.literal('none') })
  ]),
  decision: z.enum(['pending', 'accepted', 'rejected'])
})

const recordShape = z.object({
  version: z.literal(1),
  briefId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  workspaceKey,
  original: z.object({
    text: z.string().min(1).max(LIMITS.requestChars),
    attachments: z
      .array(z.object({ name: z.string().min(1).max(260), path: z.string().min(1).max(4096) }))
      .max(LIMITS.attachments)
  }),
  namedModels: z.array(z.string().min(1).max(200)).max(LIMITS.namedModels),
  drafter: actor,
  revisions: z.array(revision).min(1).max(LIMITS.revisionsKept),
  approval: z
    .object({ revision: revisionNumber, contentHash: hash, workspaceKey, approvedAt: z.number() })
    .nullable(),
  starts: z.array(start).max(LIMITS.startsKept),
  challenge: z
    .object({
      revision: revisionNumber,
      reviewer: actor,
      findings: z.array(finding).max(LIMITS.findings),
      status: z.enum(['open', 'applied'])
    })
    .nullable(),
  challengeCycles: z.number().int().min(0).max(LIMITS.challengeCycles),
  updatedAt: z.number()
})

/**
 * Saved briefs are validated on read, including the current revision's hash, so approval
 * and start decisions never rest on content that changed outside the app.
 */
export const assistedBriefRecordSchema = recordShape.superRefine((record, context) => {
  const current = record.revisions.at(-1)
  if (!current) {
    return
  }
  const expected = computeBriefContentHash(current.content, record)
  if (expected !== current.contentHash) {
    context.addIssue({ code: 'custom', message: 'The current revision does not match its hash.' })
  }
})

export function parseAssistedBriefRecord(value: unknown): AssistedBriefRecord {
  return assistedBriefRecordSchema.parse(value) as AssistedBriefRecord
}
