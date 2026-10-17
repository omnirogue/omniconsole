import { z } from 'zod'

// The omnios finance workspace, read exactly as the web console reads
// GET /api/accounting?company= — bank balances, bank activity and the books'
// connection state. Read-only: the only write is the refresh the person asks for.

export const ACCOUNTING_COMPANY_IDS = ['omnirogue', 'acme'] as const
export type AccountingCompany = (typeof ACCOUNTING_COMPANY_IDS)[number]
export const ACCOUNTING_COMPANIES: Record<AccountingCompany, string> = {
  omnirogue: 'OmniRogue',
  acme: 'ACME'
}
export const accountingCompany = z.enum(ACCOUNTING_COMPANY_IDS)
export function isAccountingCompany(value: string): value is AccountingCompany {
  return ACCOUNTING_COMPANY_IDS.some((id) => id === value)
}

const minor = z.number().finite().nullable()
const bankAccount = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  mask: z.string().nullable().default(null),
  currency: z.string(),
  cash_available_minor: minor.default(null),
  cash_posted_minor: minor.default(null),
  credit_available_minor: minor.default(null),
  credit_posted_minor: minor.default(null),
  credit_owed_minor: minor.default(null)
})
const bankTransaction = z.object({
  id: z.string(),
  account_id: z.string(),
  occurred_at: z.string(),
  description: z.string().default(''),
  amount_minor: minor.default(null),
  currency: z.string(),
  status: z.string(),
  detailed_status: z.string().nullable().default(null),
  ledger: z.enum(['cash', 'credit', 'unknown']).catch('unknown'),
  source_url: z.string().nullable().default(null)
})
export const accountingSnapshot = z.object({
  company: accountingCompany,
  name: z.string(),
  generated_at: z.string(),
  bank: z.object({
    status: z.string(),
    last_synced_at: z.string().nullable().default(null),
    last_attempt_at: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    accounts: z.array(bankAccount),
    transactions: z.array(bankTransaction),
    coverage: z.object({
      from: z.string().nullable().default(null),
      to: z.string().nullable().default(null),
      complete: z.boolean().default(false)
    })
  }),
  books: z.object({
    status: z.enum(['not_connected', 'ready', 'error']).catch('error'),
    last_synced_at: z.string().nullable().default(null),
    company_name: z.string().nullable().default(null),
    realm_id: z.string().nullable().default(null),
    connection_url: z.string().default(''),
    note: z.string().nullable().default(null)
  }),
  automation: z.object({
    task_url: z.string().nullable().default(null),
    task_title: z.string().nullable().default(null),
    status: z.string().default(''),
    source: z.string().default(''),
    note: z.string().nullable().default(null)
  })
})
export const accountingSyncReceipt = z.object({ queued: z.literal(true) })
export const accountingTransactionsCsv = z.object({
  company: accountingCompany,
  filename: z.string(),
  csv: z.string()
})

export type BankAccount = z.infer<typeof bankAccount>
export type BankTransaction = z.infer<typeof bankTransaction>
export type AccountingSnapshot = z.infer<typeof accountingSnapshot>
export type AccountingTransactionsCsv = z.infer<typeof accountingTransactionsCsv>
