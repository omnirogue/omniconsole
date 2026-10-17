import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'

/**
 * The browser-login rail (Prompt 3, 2026-09-15): shared AirTop browser profiles —
 * one company-scope identity per site, re-logged from Settings → Backoffice
 * rather than by asking anyone for the underlying API key or password. Every
 * shape here is the hub's answer relayed by the console BFF
 * (`/api/connections/browser-profiles[/{id}[/open|save|verify]]`,
 * `/api/admin/browser-profiles/verify-all`), validated at the desktop boundary.
 * Never a credential — status, a live-view URL to act inside, and reasons only.
 */

const nullableText = z.string().nullable().optional()

/** The action verbs a row's `actions` may ever contain. */
export const browserLoginAction = z.enum(['open', 'save', 'verify'])
export type BrowserLoginAction = z.infer<typeof browserLoginAction>

export const browserProfileId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const browserProfile = z
  .object({
    profile_id: z.string(),
    service: z.string(),
    url: nullableText,
    company_id: nullableText,
    company_slug: nullableText,
    login_status: z.string().default('not_verified'),
    verified_at: nullableText,
    reason_code: nullableText,
    revision: z.number().default(0),
    operate_capability: nullableText,
    identity_notice: nullableText,
    actions: z.array(z.string()).default([]),
    notes: nullableText,
    aliases: z.array(z.string()).default([])
  })
  .passthrough()
export type BrowserProfile = z.infer<typeof browserProfile>

/** GET /api/connections/browser-profiles — every shared profile the reader may see. */
export const browserProfilesList = z
  .object({
    profiles: z.array(browserProfile).default([])
  })
  .passthrough()
export type BrowserProfilesList = z.infer<typeof browserProfilesList>

/** The answer of status/open/save/verify: one profile's live login state. */
export const browserLoginStatus = z
  .object({
    profile_id: z.string(),
    service: z.string(),
    login_status: z.string().default('not_verified'),
    revision: z.number().default(0),
    verified_at: nullableText,
    reason_code: nullableText,
    live_view_url: nullableText
  })
  .passthrough()
export type BrowserLoginStatus = z.infer<typeof browserLoginStatus>

export const addSiteRequest = z
  .object({
    profile_id: browserProfileId,
    service: z.string().trim().min(1).max(200),
    url: z
      .string()
      .url()
      .regex(/^https:\/\//),
    company_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    verification_url: z
      .string()
      .url()
      .regex(/^https:\/\//)
      .optional(),
    expected_identity: z.string().trim().min(1).max(200).optional()
  })
  .strict()
export type AddSiteRequest = z.infer<typeof addSiteRequest>

/** POST /api/admin/browser-profiles/verify-all — a bounded, synchronous sweep run now. */
export const verifyAllReport = z.object({}).passthrough()
export type VerifyAllReport = z.infer<typeof verifyAllReport>

/** The desktop's browser-login rail surface. Every call is signed in main as the person. */
export type BrowserLoginsApi = {
  /** Every shared profile this reader may see, with status and the actions they may take. */
  list: () => Promise<ConsoleWorkflowResult<BrowserProfilesList>>
  /** One profile's live login state. */
  status: (args: { profile_id: string }) => Promise<ConsoleWorkflowResult<BrowserLoginStatus>>
  /** Open the live view (optionally reconnecting an existing session). */
  open: (args: {
    profile_id: string
    reconnect?: boolean
  }) => Promise<ConsoleWorkflowResult<BrowserLoginStatus>>
  /** "I've logged in": save the session at the revision it was opened at. */
  save: (args: {
    profile_id: string
    expected_revision: number
  }) => Promise<ConsoleWorkflowResult<BrowserLoginStatus>>
  /** Re-check whether the saved session is still signed in. */
  verify: (args: {
    profile_id: string
    expected_revision: number
  }) => Promise<ConsoleWorkflowResult<BrowserLoginStatus>>
  /** Add a new shared site to the rail. */
  add: (args: AddSiteRequest) => Promise<ConsoleWorkflowResult<BrowserProfile>>
  /** Admins only: run the daily verify sweep synchronously, bounded. */
  verifyAll: () => Promise<ConsoleWorkflowResult<VerifyAllReport>>
}
