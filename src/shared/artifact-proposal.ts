import { z } from 'zod'

export function isCredentialFreeHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return (
      url.protocol === 'https:' && !url.username && !url.password && !url.port && !/\s/.test(text)
    )
  } catch {
    return false
  }
}

const httpsUrl = z
  .string()
  .max(2048)
  .refine(isCredentialFreeHttpsUrl, 'Expected an HTTPS URL without credentials')

/** Descriptive context; authority always belongs to the server's exact artifact revision. */
export const artifactProposalSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['plan', 'customer_send', 'ad_launch', 'budget', 'deployment', 'other']),
    proposal_version: z.string().max(120).optional(),
    plan_url: httpsUrl
      .refine((text) => {
        try {
          const url = new URL(text)
          return (
            url.hostname === 'example.slite.com' &&
            /^\/app\/docs\/[^/]+\/?$/.test(url.pathname) &&
            !url.search &&
            !url.hash
          )
        } catch {
          return false
        }
      })
      .optional(),
    proposal_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    scope: z.string().max(2500).optional(),
    targets: z.string().max(1000).optional(),
    limits: z.string().max(1000).optional(),
    expected_effect: z.string().max(1500).optional(),
    risks: z.string().max(1500).optional(),
    owner: z.string().max(160).optional(),
    next_action: z.string().max(1000).optional(),
    evidence: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(160),
            url: httpsUrl,
            observed_at: z.string().max(80).optional()
          })
          .strict()
      )
      .max(10)
      .optional()
  })
  .strict()

export type ArtifactProposal = z.infer<typeof artifactProposalSchema>
