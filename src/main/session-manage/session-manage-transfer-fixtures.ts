import { vi } from 'vitest'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { AskWaitResult } from './session-manage-ask-wait'
import { agentProcess, manageEntry, sidebarRow } from './session-manage-test-fixtures'
import type { SessionTransferDeps, TransferSession } from './session-manage-transfer-contract'

export function transferSession(
  paneKey: string,
  overrides: Partial<SessionManageEntry> = {}
): TransferSession {
  const entry = manageEntry({ paneKey, title: paneKey, ...overrides })
  return {
    entry,
    row: sidebarRow({
      paneKey,
      viewKey: paneKey,
      title: entry.title,
      worktreeId: entry.worktreeId
    }),
    source: { kind: 'pty', worktreeId: entry.worktreeId, paneKey },
    agentProcess: agentProcess()
  }
}

export function transferFixture() {
  const events: string[] = []
  const target = transferSession('target')
  const deps = {
    assertCheckpoints: vi.fn<SessionTransferDeps['assertCheckpoints']>(),
    refresh: vi.fn(async (session: TransferSession) => session),
    ask: vi.fn<SessionTransferDeps['ask']>(async () => {
      events.push('ask')
      return {
        sent: 'question',
        wait: Promise.resolve<AskWaitResult>({
          outcome: 'answered',
          reply: 'Goal: parser fix. Done: investigation. Left: edit parser.ts. Next: fix syntax.'
        })
      }
    }),
    deliver: vi.fn<SessionTransferDeps['deliver']>(async () => {
      events.push('deliver')
      return {
        sent: 'brief',
        acknowledgement: 'Accepted transfer fixture',
        wait: Promise.resolve<AskWaitResult>({
          outcome: 'answered',
          reply: 'Accepted transfer fixture'
        })
      }
    }),
    create: vi.fn(async (_source: TransferSession, title: string) => {
      events.push('create')
      return { ...target, entry: { ...target.entry, title } }
    }),
    file: vi.fn(async () => {
      events.push('file')
    }),
    archive: vi.fn(async () => {
      events.push('archive')
      return { status: 'archived' as const }
    }),
    audit: vi.fn<SessionTransferDeps['audit']>(async (record) => {
      events.push(`audit:${record.action}`)
      return undefined
    })
  } satisfies SessionTransferDeps
  return { deps, target, events }
}
