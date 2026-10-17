import { z } from 'zod'

const label = z.string().min(1).max(512)

/** Only the signed task admission response supplies eligible outcome choices. */
export const consoleTaskSetup = z.object({
  gaps: z.array(z.string().min(1).max(96)).max(16),
  company_id: z.string().min(1).max(128),
  goals: z
    .array(
      z.object({
        id: z.string().regex(/^cgl_[A-Za-z0-9_-]{1,128}$/),
        title: label,
        org_unit_id: z.string().max(128).nullish(),
        horizon: z.string().max(128).nullish(),
        status: z.string().max(64)
      })
    )
    .max(100),
  action_url: z.string().max(4096).optional()
})

export type ConsoleTaskSetup = z.infer<typeof consoleTaskSetup>
