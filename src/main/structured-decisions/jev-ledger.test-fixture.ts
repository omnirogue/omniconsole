import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JevCallFields } from './jev-ledger'

/** A complete, valid in-app call row with fixed ids for ledger tests. */
export function jevCallFieldsFixture(overrides: Partial<JevCallFields> = {}): JevCallFields {
  return {
    record_key: 'jev-call:00000000-0000-4000-8000-000000000001',
    request_id: '00000000-0000-4000-8000-000000000001',
    observed_at: '2026-10-03T12:00:00.000Z',
    caller: 'session-owner',
    transport: 'direct',
    deadline_ms: 8000,
    model: 'jev-1.13.0',
    ref: 'sessions.find-owner',
    ref_hash: 'a'.repeat(64),
    input_hash: 'b'.repeat(64),
    question_ids: ['duplicate'],
    status: null,
    provider_status: 'evaluated',
    kind: null,
    reason: null,
    answers: { duplicate: { type: 'noul', noul: 0.12 } },
    usage: { input_tokens: 120, output_tokens: 8 },
    elapsed_ms: 251.4,
    calls: 1,
    ...overrides
  }
}

/** Temporary `<userData>/structured-decisions/jev-ledger` directories, removed by `cleanup`. */
export function ledgerDirectories() {
  const roots: string[] = []
  return {
    async create(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), 'jev-ledger-'))
      roots.push(root)
      return join(root, 'structured-decisions', 'jev-ledger')
    },
    async cleanup(): Promise<void> {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    }
  }
}

export async function readLedgerLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
