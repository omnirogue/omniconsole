import { z } from 'zod'

/** CONTRACT.md §1 (conversational waits): the omnios side answers, the IDE engine decides. */
const personId = z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/)
const line = z.string().trim().min(1).max(2_000)

export const waitPeopleResponse = z.object({
  people: z
    .array(
      z.object({
        person_id: personId,
        name: z.string().trim().min(1).max(200),
        channels: z
          .object({
            slack: z.boolean(),
            email: z.boolean(),
            jira: z.boolean(),
            signin: z.array(z.string().min(1).max(64)).max(64)
          })
          .partial()
      })
    )
    .max(2_000)
})
export type WaitPeopleResponse = z.infer<typeof waitPeopleResponse>

export const waitFactsResponse = z.object({
  status: z.enum(['met', 'pending', 'needs_you', 'unavailable']),
  evidence: z
    .object({
      at: z.string().min(1).max(64),
      by: z.object({ person_id: personId, name: z.string().min(1).max(200) }),
      link: z.string().min(1).max(2_000),
      excerpt: z.string().max(2_000).optional(),
      kind: z.string().min(1).max(64)
    })
    .optional(),
  reason: line.optional(),
  checked_at: z.string().min(1).max(64).optional()
})
export type WaitFactsResponse = z.infer<typeof waitFactsResponse>

export const waitAskRequest = z
  .object({
    operation_id: z.string().regex(/^[\x21-\x7e]{8,128}$/),
    source: z.enum(['slack', 'email']),
    person_id: personId,
    text: z.string().trim().min(1).max(2_000),
    company: z.string().min(1).max(64).optional(),
    origin: z
      .object({
        session_ref: z.string().min(1).max(256).optional(),
        chain_id: z.string().min(1).max(128).optional(),
        outcome_id: z.string().min(1).max(128).optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type WaitAskRequest = z.infer<typeof waitAskRequest>

export const waitAskResponse = z.object({
  handle: z.string().min(1).max(512),
  asked_at: z.string().min(1).max(64),
  person: z.object({ person_id: personId, name: z.string().min(1).max(200) }),
  link: z.string().max(2_000).optional()
})
export type WaitAskResponse = z.infer<typeof waitAskResponse>
