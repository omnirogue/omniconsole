import { describe, expect, it, vi } from 'vitest'
import type { SessionManageConversationOrganization } from '../../shared/session-manage-relay'
import type { OrganizationChange } from '../../shared/session-organization-change'
import type { SessionResumeDeps } from '../session-manage/session-manage-resume'
import { manageEntry } from '../session-manage/session-manage-test-fixtures'
import { restoreDeletedForAnswerWith, type AnswerRestoreDeps } from './restore-deleted-for-answer'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const REF = `claude:${ID}@local`
const MANAGED = '/Users/maintainer/app/claude-accounts/7b2e/auth/session'
const actor = { kind: 'steward' as const, feature: 'rules' as const }
const ANSWER = {
  ref: REF,
  deliveryKey: 'review:plan:d42',
  approvedBy: 'sal@example.edu',
  actor
}
const REASON =
  'restored for an answered decision review:plan:d42, approved by sal@example.edu'
const DELETED_KEY = 'deleted-key'
const HIDDEN_KEY = 'hidden-key'

function resumeDeps(
  organization: SessionManageConversationOrganization,
  overrides: Partial<SessionResumeDeps> = {}
): Omit<SessionResumeDeps, 'restoreDeleted'> {
  return {
    readRows: async () => [],
    observe: async () => manageEntry(),
    organization: async () => organization,
    locate: async () => [
      { path: `${MANAGED}/projects/-w/${ID}.jsonl`, providerRoot: MANAGED, defaultRoot: false }
    ],
    transcriptCwd: async () => '/w',
    restart: vi.fn(),
    launch: vi.fn(async () => ({
      terminal: 'term_new',
      tabId: 'tab-7',
      paneKey: 'tab-7:leaf-7',
      disposition: 'created' as const
    })),
    confirm: async () => ({ state: 'same', paneKey: 'tab-7:leaf-7' }),
    platform: 'darwin',
    hostLabel: 'laptop',
    ...overrides
  }
}

function restoreDeps(
  after: SessionManageConversationOrganization | null = {
    deleted: false,
    hidden: false,
    archiveKind: null
  },
  failKind?: OrganizationChange['kind']
) {
  const relayed: OrganizationChange[] = []
  const deps = {
    ledger: { prepare: vi.fn(async () => ({}) as never), settle: vi.fn(async () => ({}) as never) },
    relay: vi.fn(async (request: Parameters<AnswerRestoreDeps['relay']>[0]) => {
      // restore relays applyOrganizationChange, which carries the whole change
      const change = (request as { change: OrganizationChange }).change
      if (change.kind === failKind) {
        throw new Error('The window refused it. Nothing changed.')
      }
      relayed.push(change)
      return { opId: change.opId, targets: change.targets, value: change.value }
    }),
    organization: vi.fn(async () => after),
    audit: vi.fn(async () => undefined)
  } satisfies AnswerRestoreDeps
  return { deps, relayed }
}

const deleted = {
  deleted: true,
  hidden: false,
  archiveKind: null,
  deletedKeys: [DELETED_KEY]
}

describe('restoreDeletedForAnswer', () => {
  it('undeletes through a recorded change, audits the answer, then resumes the same conversation', async () => {
    const resume = resumeDeps(deleted)
    const { deps, relayed } = restoreDeps()
    const result = await restoreDeletedForAnswerWith(resume, deps, ANSWER)
    expect(relayed).toEqual([
      expect.objectContaining({
        kind: 'delete',
        targets: [{ sessionKey: DELETED_KEY }],
        value: false,
        executor: { kind: 'app', feature: 'answer-delivery' },
        reason: REASON
      })
    ])
    expect(deps.ledger.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'delete', reason: REASON }),
      { audit: expect.objectContaining({ actor: { actor: 'answer-delivery' } }) }
    )
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'answer-delivery',
        action: 'resume',
        target: { title: REF },
        reason: REASON,
        answerDelivery: {
          deliveryKey: 'review:plan:d42',
          approvedBy: 'sal@example.edu'
        }
      })
    )
    expect(result).toMatchObject({ ok: true, restored: true })
    expect(result.ok && result.resumed.outcome).toBe('resumed')
    expect(result.ok && result.summary).toContain(
      `It had been removed from the sidebar; ${REASON}.`
    )
    expect(resume.launch).toHaveBeenCalledTimes(1)
  })

  it('undoes a delete and a hide together, as two recorded changes', async () => {
    const { deps, relayed } = restoreDeps()
    await restoreDeletedForAnswerWith(
      resumeDeps({ ...deleted, hidden: true, hiddenKeys: [HIDDEN_KEY] }),
      deps,
      ANSWER
    )
    expect(relayed.map((change) => [change.kind, change.targets, change.value])).toEqual([
      ['delete', [{ sessionKey: DELETED_KEY }], false],
      ['unhide', [{ sessionKey: HIDDEN_KEY }], false]
    ])
    expect(new Set(relayed.map((change) => change.opId)).size).toBe(2)
  })

  it('resumes a conversation nobody removed without touching the sidebar', async () => {
    const { deps } = restoreDeps()
    const result = await restoreDeletedForAnswerWith(
      resumeDeps({ deleted: false, hidden: false, archiveKind: null }),
      deps,
      ANSWER
    )
    expect(result).toMatchObject({ ok: true, restored: false })
    expect(deps.relay).not.toHaveBeenCalled()
    expect(deps.audit).not.toHaveBeenCalled()
  })

  it('changes nothing when an older window cannot name the entry that deletes it', async () => {
    const resume = resumeDeps({ deleted: true, hidden: false, archiveKind: null })
    const { deps } = restoreDeps()
    const result = await restoreDeletedForAnswerWith(resume, deps, ANSWER)
    expect(result).toMatchObject({ ok: false, restored: false })
    expect(!result.ok && result.reason).toContain('too old')
    expect(deps.relay).not.toHaveBeenCalled()
    expect(resume.launch).not.toHaveBeenCalled()
  })

  it('does not reopen a conversation that still reads as hidden after the change', async () => {
    const resume = resumeDeps({
      deleted: false,
      hidden: true,
      archiveKind: null,
      hiddenKeys: [HIDDEN_KEY]
    })
    const { deps } = restoreDeps({ deleted: false, hidden: true, archiveKind: null })
    const result = await restoreDeletedForAnswerWith(resume, deps, ANSWER)
    expect(!result.ok && result.reason).toContain('unhidden it, but it still reads as hidden')
    expect(deps.audit).not.toHaveBeenCalled()
    expect(resume.launch).not.toHaveBeenCalled()
  })

  it('says what already applied when the second change fails', async () => {
    const resume = resumeDeps({ ...deleted, hidden: true, hiddenKeys: [HIDDEN_KEY] })
    const { deps } = restoreDeps(undefined, 'unhide')
    const result = await restoreDeletedForAnswerWith(resume, deps, ANSWER)
    expect(!result.ok && result.reason).toContain(
      'The window refused it. Nothing changed. Already done: undeleted.'
    )
    expect(resume.launch).not.toHaveBeenCalled()
  })

  it('refuses without the delivery or its approver', async () => {
    const resume = resumeDeps(deleted)
    const { deps } = restoreDeps()
    const result = await restoreDeletedForAnswerWith(resume, deps, { ...ANSWER, approvedBy: ' ' })
    expect(result).toMatchObject({ ok: false, restored: false })
    expect(deps.relay).not.toHaveBeenCalled()
    expect(resume.launch).not.toHaveBeenCalled()
  })

  it('reports a restored row whose reopen then failed as partial', async () => {
    const resume = resumeDeps(deleted, {
      confirm: async () => ({ state: 'different', reported: 'new-id' })
    })
    const { deps } = restoreDeps()
    const result = await restoreDeletedForAnswerWith(resume, deps, ANSWER)
    expect(result).toMatchObject({ ok: false, restored: true, partial: true })
    expect(!result.ok && result.reason).toContain('Already done: brought back to the sidebar')
  })
})
