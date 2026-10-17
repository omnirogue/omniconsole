import { z } from 'zod'
import type { OrgView } from './console-org-contract'
import type { WorkFolders } from './console-work-folders-contract'
import type { ConsoleWorkflowResult } from './console-workflow-types'
import type {
  accountingSnapshot,
  accountingTransactionsCsv,
  AccountingCompany
} from './console-accounting-contract'
import type { companyHealthView } from './console-company-health-contract'
import type { ScorecardDocument } from './console-scorecard-contract'

// The estate's read-only company projections, exactly as the omnios web console
// reads them: /api/estate/rollup, /api/estate/company/{id}, /api/estate/missions,
// /api/estate/today and /api/org. Each answer carries how old it is (`age_s`),
// whether it came from memory past its TTL (`stale`) and why the newest attempt
// failed (`last_error`) — the pages show that instead of blanking.
const freshness = {
  age_s: z.number().nullable().optional(),
  stale: z.boolean().nullable().optional(),
  last_error: z.string().nullable().optional()
}
const feed = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    available: z.boolean(),
    reason: z.string().nullable().optional(),
    items: z.array(item)
  })
const nullableText = z.string().nullable().optional()

export const rollupCompany = z
  .object({
    company_id: nullableText,
    slug: nullableText,
    name: nullableText,
    status: nullableText,
    total: z.number().nullable().optional(),
    active: z.number().nullable().optional(),
    queued: z.number().nullable().optional(),
    recent: z.number().nullable().optional(),
    failed: z.number().nullable().optional(),
    completed: z.number().nullable().optional(),
    running: z.number().nullable().optional()
  })
  .passthrough()
export const estateRollup = z.object({
  ...freshness,
  ok: z.boolean(),
  reason: nullableText,
  window_hours: z.number().nullable().optional(),
  companies: z.array(rollupCompany)
})

export const estateMission = z
  .object({
    id: nullableText,
    title: nullableText,
    company_id: nullableText,
    owner_employee_id: nullableText,
    horizon: nullableText,
    status: nullableText,
    domain: nullableText
  })
  .passthrough()
export const estateQueueItem = z
  .object({
    key: nullableText,
    source: nullableText,
    task_id: nullableText,
    title: nullableText,
    state: nullableText,
    priority: nullableText
  })
  .passthrough()
export const estateMissions = z.object({
  ...freshness,
  ok: z.boolean(),
  missions: feed(estateMission),
  queue: feed(estateQueueItem)
})

export const estateToday = z.object({
  ...freshness,
  ok: z.boolean(),
  briefing: z.object({
    available: z.boolean(),
    reason: nullableText,
    value: z
      .object({
        title: nullableText,
        // Why: the hub's briefing summary is a structured object; older rows carry text.
        summary: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .nullable()
          .optional(),
        created_at: nullableText
      })
      .passthrough()
      .nullable()
      .optional()
  }),
  pulse: z.object({
    available: z.boolean(),
    reason: nullableText,
    value: z.record(z.string(), z.unknown()).nullable().optional()
  })
})

export const companyGoal = z
  .object({
    id: nullableText,
    title: nullableText,
    horizon: nullableText,
    status: nullableText,
    owner_employee_id: nullableText,
    org_unit_id: nullableText
  })
  .passthrough()
export const estateCompany = z.object({
  ...freshness,
  ok: z.boolean(),
  company_id: z.string(),
  cockpit: z.object({
    available: z.boolean(),
    reason: nullableText,
    value: z.record(z.string(), z.unknown()).nullable().optional()
  }),
  goals: feed(companyGoal)
})

export { orgCompany, orgDomain, orgView } from './console-org-contract'

// ── the signed-in person (GET /api/me) ────────────────────────────────────────
// `companies` is the company scope the console enforces on every read: null
// means the whole estate (an admin), a list means only those companies.
export const consoleMe = z
  .object({
    ok: z.boolean().default(true),
    mode: z.string().optional(),
    reason: nullableText,
    user: z
      .object({
        id: nullableText,
        email: nullableText,
        name: nullableText,
        role: nullableText,
        employee_id: nullableText,
        department_id: nullableText,
        department_name: nullableText
      })
      .passthrough()
      .nullable()
      .optional(),
    sections: z.array(z.string()).nullable().optional(),
    pages: z.array(z.string()).nullable().optional(),
    companies: z.array(z.string()).nullable().optional(),
    company_scope: nullableText
  })
  .passthrough()

// ── the people (GET /api/orgchart through the hub relay) ──────────────────────
export const orgChartPerson = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    email: nullableText,
    employee_id: nullableText,
    photo_url: nullableText
  })
  .passthrough()
export const orgChartUnit = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string().optional(),
    parent_person_id: nullableText,
    lead_person_id: nullableText,
    position: z.number().optional(),
    member_ids: z.array(z.string()).default([])
  })
  .passthrough()
export const orgChart = z.object({ people: z.array(orgChartPerson), units: z.array(orgChartUnit) })

export type RollupCompany = z.infer<typeof rollupCompany>
export type EstateRollup = z.infer<typeof estateRollup>
export type EstateMission = z.infer<typeof estateMission>
export type EstateMissions = z.infer<typeof estateMissions>
export type EstateToday = z.infer<typeof estateToday>
export type CompanyGoal = z.infer<typeof companyGoal>
export type EstateCompany = z.infer<typeof estateCompany>
export type { OrgCompany, OrgDomain, OrgView } from './console-org-contract'
export type ConsoleMe = z.infer<typeof consoleMe>
export type OrgChartPerson = z.infer<typeof orgChartPerson>
export type OrgChartUnit = z.infer<typeof orgChartUnit>
export type OrgChart = z.infer<typeof orgChart>

/** Company ids the estate uses in a path; the BFF refuses anything else. */
export const companyId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
/** Scorecard scopes are slugs, never free text. */
export const healthScope = z
  .object({
    company: z
      .string()
      .regex(/^[a-z0-9_-]{1,64}$/)
      .optional(),
    domain: z
      .string()
      .regex(/^[a-z0-9_-]{1,64}$/)
      .optional()
  })
  .strict()

/** The desktop's read surface for Sal's companies view. Every call is signed in main. */
export type ConsoleCompaniesApi = {
  rollup: () => Promise<ConsoleWorkflowResult<EstateRollup>>
  scorecard: () => Promise<ConsoleWorkflowResult<ScorecardDocument>>
  me: () => Promise<ConsoleWorkflowResult<ConsoleMe>>
  orgChart: () => Promise<ConsoleWorkflowResult<OrgChart>>
  missions: () => Promise<ConsoleWorkflowResult<EstateMissions>>
  today: () => Promise<ConsoleWorkflowResult<EstateToday>>
  org: () => Promise<ConsoleWorkflowResult<OrgView>>
  folders: () => Promise<ConsoleWorkflowResult<WorkFolders>>
  company: (args: { companyId: string }) => Promise<ConsoleWorkflowResult<EstateCompany>>
  health: (args: {
    company?: string
    domain?: string
  }) => Promise<ConsoleWorkflowResult<z.infer<typeof companyHealthView>>>
  accounting: (args: {
    company: AccountingCompany
  }) => Promise<ConsoleWorkflowResult<z.infer<typeof accountingSnapshot>>>
  syncAccounting: (args: {
    company: AccountingCompany
  }) => Promise<ConsoleWorkflowResult<{ queued: true }>>
  transactionsCsv: (args: {
    company: AccountingCompany
  }) => Promise<ConsoleWorkflowResult<z.infer<typeof accountingTransactionsCsv>>>
}
