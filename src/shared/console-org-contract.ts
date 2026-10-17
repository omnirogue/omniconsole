import { z } from 'zod'

const nullableText = z.string().nullable().optional()

// ── the org tree (GET /api/org) ───────────────────────────────────────────────
export const orgDomain = z.object({
  id: nullableText,
  name: nullableText,
  workstreams: z.array(z.string()).default([])
})
export const orgCompany = z.object({
  id: nullableText,
  slug: nullableText,
  name: nullableText,
  available: z.boolean().default(true),
  domains: z.array(orgDomain).default([])
})
export const orgView = z.object({
  ok: z.boolean(),
  reason: nullableText,
  stale: z.boolean().optional(),
  companies: z.array(orgCompany)
})
export type OrgDomain = z.infer<typeof orgDomain>
export type OrgCompany = z.infer<typeof orgCompany>
export type OrgView = z.infer<typeof orgView>
