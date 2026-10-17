import { describe, expect, it } from 'vitest'
import type {
  OrganizationHistory,
  OrganizationRecord,
  OrganizationUndoPlan
} from '../../shared/session-organization-change'
import { readMergedHistory, undoableOpIds } from './organization-session-history'

const at = (
  opId: string,
  ts: string,
  kind: OrganizationRecord['kind'] = 'move'
): OrganizationRecord => ({
  opId,
  kind,
  targets: [{ sessionKey: 'k' }],
  value: null,
  executor: { kind: 'cli' },
  phase: 'applied',
  ts
})

function fakeLedger(
  histories: Record<string, Partial<OrganizationHistory>>,
  undoable: string[] = []
) {
  return {
    history: async (key: string): Promise<OrganizationHistory> => ({
      key,
      entries: [],
      pending: [],
      ownership: {},
      revocations: {},
      ...histories[key]
    }),
    undoPlan: async (opId: string): Promise<OrganizationUndoPlan> => {
      if (opId === 'gone') {
        throw new Error('No applied change')
      }
      return {
        opId,
        inverse: undoable.includes(opId) ? { kind: 'move', targets: [], value: null } : null,
        targets: [],
        partial: false
      }
    }
  }
}

describe('readMergedHistory', () => {
  it('merges what was recorded under the pane before the row had its key, newest first', async () => {
    const ledger = fakeLedger({
      'claude:abc': {
        entries: [at('rename', '2026-09-25T10:05:00Z', 'title')],
        revocations: {
          title: { at: '2026-09-25T10:05:00Z', opId: 'rename', why: 'person/sidebar' }
        }
      },
      'pane:tab-1:leaf-1': {
        entries: [
          at('filed', '2026-09-25T10:00:00Z'),
          at('rename', '2026-09-25T10:05:00Z', 'title')
        ]
      }
    })
    const history = await readMergedHistory(ledger, ['claude:abc', 'pane:tab-1:leaf-1'])
    expect(history.key).toBe('claude:abc')
    expect(history.entries.map((entry) => entry.opId)).toEqual(['rename', 'filed'])
    expect(history.revocations.title?.opId).toBe('rename')
  })
})

describe('undoableOpIds', () => {
  it('names applied changes whose Undo still has something to put back', async () => {
    const ledger = fakeLedger({}, ['a'])
    const failed: OrganizationRecord = { ...at('c', '2026-09-25T10:00:00Z'), phase: 'failed' }
    await expect(
      undoableOpIds(ledger, [at('a', '1'), at('b', '2'), failed, at('gone', '3')])
    ).resolves.toEqual(['a'])
  })
})
