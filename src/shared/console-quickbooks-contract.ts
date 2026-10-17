import { z } from 'zod'
import { ACCOUNTING_COMPANY_IDS } from './console-accounting-contract'
import type { ConsoleWorkflowResult } from './console-workflow-types'

/**
 * The books connection, read as the console reads
 * `GET /api/accounting/connections/quickbooks`.
 *
 * Read-only. Authorizing a company, choosing its ledger accounts and re-checking a
 * connection are all writes, and one of them is an OAuth consent only Sal can give, so
 * none of them belongs on this surface. What the IDE shows is the STATE: which companies
 * are connected, what each is waiting on, and in whose words.
 */

const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? null)

export const QBO_LEDGERS = ['cash', 'credit'] as const
export type QboLedger = (typeof QBO_LEDGERS)[number]

const qboMapping = z
  .object({
    ledger_kind: z.enum(QBO_LEDGERS),
    account_id: z.string(),
    expected_type: z.string(),
    source_account_id: z.string()
  })
  .passthrough()

export const qboCompany = z
  .object({
    company_id: z.string(),
    company_slug: z.enum(ACCOUNTING_COMPANY_IDS),
    company_name: z.string().default(''),
    realm_id: optionalText,
    mapped_company_name: optionalText,
    /** The connection's own word for where it is stuck, or that it is not. */
    status: z.string().default(''),
    reason_code: optionalText,
    checked_at: optionalText,
    reviewed_by: optionalText,
    mappings: z.array(qboMapping).default([])
  })
  .passthrough()

export const qboStatus = z
  .object({
    provider: z.string(),
    oauth: z
      .object({
        configured: z.boolean().default(false),
        connect_supported: z.boolean().default(false),
        /** What the app connection still needs before a company can be authorized. */
        missing_requirements: z.array(z.string()).default([])
      })
      .passthrough(),
    companies: z.array(qboCompany).default([]),
    sync_health: z.string().default('')
  })
  .passthrough()

export type QboCompany = z.infer<typeof qboCompany>
export type QboStatus = z.infer<typeof qboStatus>

/**
 * The connection's state in a person's words. An unrecognised status is shown as the
 * provider spelled it rather than flattened to "unknown", because a status this surface
 * has not seen before is information, not an error.
 */
export function connectionLabel(status: string): string {
  const known: Record<string, string> = {
    waiting_for_access: 'Access needed',
    mapping_required: 'Choose accounts',
    verification_pending: 'Check needed',
    connected_enabled: 'Feed enabled',
    not_enabled: 'Feed not enabled',
    provider_error: 'Check failed',
    unsupported_observation: 'Feed status unavailable',
    mapping_mismatch: 'Review mapping'
  }
  return known[status] ?? (status === '' ? 'Not yet verified' : status.replaceAll('_', ' '))
}

/** Why a connection is where it is, in the same words the console uses. */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) {
    return 'Verification has not completed.'
  }
  const known: Record<string, string> = {
    oauth_not_configured: 'The QuickBooks app connection needs to be configured.',
    access_missing: 'Authorize access to this QuickBooks company.',
    mapping_required: 'Review the company and select both Slash ledger accounts.',
    online_banking_disabled: 'Enable this account’s bank feed in QuickBooks.',
    online_banking_unknown: 'QuickBooks did not return a definite bank-feed status.',
    stale: 'The previous verification expired. Check again.',
    mapping_mismatch: 'The saved mapping no longer matches the provider evidence.'
  }
  return known[reason] ?? reason.replaceAll('_', ' ')
}

/** True only when the books are actually feeding; every other status is not connected. */
export function isFeedEnabled(company: QboCompany): boolean {
  return company.status === 'connected_enabled'
}

export type ConsoleQuickBooksApi = {
  status: () => Promise<ConsoleWorkflowResult<QboStatus>>
}
