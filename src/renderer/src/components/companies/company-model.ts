import type { DomainHealth } from '../../../../shared/console-company-health-contract'
import type {
  AccountingSnapshot,
  BankAccount,
  BankTransaction
} from '../../../../shared/console-accounting-contract'

export type HealthFolder = { domain: DomainHealth; children: HealthFolder[] }

/** Use the visible canonical parent edges; a malformed edge never hides a folder. */
export function healthHierarchy(domains: readonly DomainHealth[]): HealthFolder[] {
  const nodes = domains.map((domain) => ({ domain, children: [] as HealthFolder[] }))
  const indices = new Map(
    domains.flatMap((domain, index) => (domain.id ? [[domain.id, index] as const] : []))
  )
  const parents = new Map<number, number>()
  domains.forEach((domain, index) => {
    const parent = domain.parent_unit_id ? indices.get(domain.parent_unit_id) : undefined
    if (parent !== undefined) {
      parents.set(index, parent)
    }
  })
  const cyclic = new Set<number>()
  for (const index of parents.keys()) {
    const path: number[] = []
    const seen = new Map<number, number>()
    let next: number | undefined = index
    while (next !== undefined) {
      const at = seen.get(next)
      if (at !== undefined) {
        path.slice(at).forEach((node) => cyclic.add(node))
        break
      }
      seen.set(next, path.length)
      path.push(next)
      next = parents.get(next)
    }
  }
  cyclic.forEach((index) => parents.delete(index))
  const roots: HealthFolder[] = []
  nodes.forEach((node, index) => {
    const parent = parents.get(index)
    if (parent === undefined) {
      roots.push(node)
    } else {
      nodes[parent].children.push(node)
    }
  })
  return roots
}

export function healthFolderName(domain: DomainHealth): string {
  return domain.id ? domain.name : 'Unassigned work'
}

export function money(minor: number | null | undefined, currency = 'USD'): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) {
    return 'Unavailable'
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`
  }
}

export function dateLabel(value: string | null | undefined, time = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return 'Not available'
  }
  return new Intl.DateTimeFormat(
    'en-US',
    time
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
  ).format(new Date(value))
}

export function label(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown'
  }
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function bankHealth(
  bank: AccountingSnapshot['bank'],
  now = Date.now()
): { text: string; tone: 'ok' | 'warning' | 'error' | 'neutral' } {
  if (bank.status === 'error' || bank.error) {
    return { text: 'Needs attention', tone: 'error' }
  }
  if (bank.status === 'not_connected') {
    return { text: 'Connection needed', tone: 'warning' }
  }
  if (bank.status === 'syncing' || bank.status === 'pending') {
    return { text: 'Updating', tone: 'neutral' }
  }
  if (!['ready', 'ok', 'connected', 'stale'].includes(bank.status)) {
    return { text: 'Status unavailable', tone: 'warning' }
  }
  const at = bank.last_synced_at ? Date.parse(bank.last_synced_at) : Number.NaN
  if (!Number.isFinite(at)) {
    return { text: 'Awaiting first sync', tone: 'warning' }
  }
  if (bank.status === 'stale' || now - at > 60 * 60 * 1000) {
    return { text: 'Update overdue', tone: 'warning' }
  }
  return { text: 'Up to date', tone: 'ok' }
}

export function isCreditAccount(account: BankAccount): boolean {
  return (
    /credit|card/i.test(account.kind) ||
    account.credit_available_minor !== null ||
    account.credit_posted_minor !== null
  )
}

export function isCashAccount(account: BankAccount): boolean {
  if (account.kind === 'charge_card') {
    return account.cash_available_minor !== null || account.cash_posted_minor !== null
  }
  return (
    !isCreditAccount(account) &&
    (/cash|checking|savings|deposit|bank/i.test(account.kind) ||
      account.cash_available_minor !== null ||
      account.cash_posted_minor !== null)
  )
}

/** No cross-currency totals, no credit counted as cash, no zero in place of missing data. */
export function accountTotals(
  accounts: BankAccount[],
  field: 'cash_available_minor' | 'credit_available_minor' | 'credit_posted_minor'
): { currency: string; amount: number | null }[] {
  const applicable = accounts.filter((account) =>
    field === 'cash_available_minor' ? isCashAccount(account) : isCreditAccount(account)
  )
  if (applicable.length === 0) {
    return []
  }
  return [...new Set(applicable.map((account) => account.currency))].map((currency) => {
    const values = applicable
      .filter((account) => account.currency === currency)
      .map((account) => account[field])
    return {
      currency,
      amount: values.every((value) => value !== null && Number.isFinite(value))
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : null
    }
  })
}

export function safeLink(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

export function filterTransactions(
  rows: BankTransaction[],
  search: string,
  status: string,
  account: string
): BankTransaction[] {
  const query = search.trim().toLowerCase()
  return rows
    .filter(
      (row) =>
        (!query ||
          row.description.toLowerCase().includes(query) ||
          row.id.toLowerCase().includes(query)) &&
        (!status || row.status === status) &&
        (!account || row.account_id === account)
    )
    .sort((a, b) => (Date.parse(b.occurred_at) || 0) - (Date.parse(a.occurred_at) || 0))
}

/**
 * Keys for lists whose items carry no id of their own: derive one from the
 * item's own content, never from its position, so filtering or reordering the
 * list cannot move a row's identity onto its neighbour. Content-identical items
 * are interchangeable, so a repeat takes a counted suffix to stay unique.
 */
export function keyedByContent<T>(
  items: readonly T[],
  describe: (item: T) => string
): { key: string; item: T }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = describe(item) || 'item'
    const repeats = seen.get(base) ?? 0
    seen.set(base, repeats + 1)
    return { key: repeats === 0 ? base : `${base}#${repeats}`, item }
  })
}
