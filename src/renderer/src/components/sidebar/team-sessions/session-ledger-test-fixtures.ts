import { vi } from 'vitest'
import type { LedgerNowResult, LedgerPublicRow, SessionLedgerApi } from '@/lib/session-ledger-types'
import type { SessionLedgerStorage } from '@/store/session-ledger-storage'

export const serverTime = '2026-09-13T12:00:00Z'
export function row(id: string, patch: Partial<LedgerPublicRow> = {}): LedgerPublicRow {
  return {
    ledger_id: id,
    employee_id: id,
    employee_name: id,
    app: 'orca',
    state: 'running',
    started_at: serverTime,
    last_activity_at: serverTime,
    ...patch
  }
}
/** A restricted row as the console publishes it (contract §0.3): same keys, safe values. */
export function restrictedRow(id: string, patch: Partial<LedgerPublicRow> = {}): LedgerPublicRow {
  return {
    ledger_id: id,
    employee_id: `${id}-employee`,
    employee_name: `${id} person`,
    app: 'omni-ide',
    agent: 'claude',
    model: null,
    host: null,
    repo: null,
    branch: null,
    company: null,
    domain: null,
    card_id: null,
    card_title: null,
    state: 'running',
    started_at: serverTime,
    last_activity_at: serverTime,
    ended_at: null,
    files_touched: [],
    last_action: null,
    activity_summary: {},
    ...patch
  }
}
export function result(rows: LedgerPublicRow[] = [], overflow = 0): LedgerNowResult {
  return { ok: true, rows, overflow, server_time: serverTime }
}
export function ledgerApi(patch: Partial<SessionLedgerApi> = {}): SessionLedgerApi {
  return {
    now: vi.fn().mockResolvedValue(result()),
    peers: vi.fn().mockResolvedValue({ ok: true, peers: [] }),
    localSessions: vi.fn().mockResolvedValue([]),
    setWaiting: vi.fn().mockResolvedValue(undefined),
    linkCard: vi.fn().mockResolvedValue(true),
    muteRepo: vi.fn().mockResolvedValue(undefined),
    mutedRepos: vi.fn().mockResolvedValue([]),
    onLocalSessionsChanged: vi.fn().mockReturnValue(vi.fn()),
    ...patch
  }
}
export function memoryStorage(): SessionLedgerStorage {
  const values = new Map<string, string[]>()
  return {
    load: (key) => values.get(key) ?? [],
    save: vi.fn((key, rows) => {
      values.set(key, rows)
    })
  }
}
