import { describe, expect, it } from 'vitest'
import { linkedCardForWorktree } from './ledger-linked-card'

const item = (hubTaskId?: string) =>
  ({
    provider: 'backoffice',
    type: 'issue',
    number: 1,
    title: 'Card',
    url: 'u',
    hubTaskId
  }) as never

describe('linked card resolution', () => {
  it('reads only the persisted hub task id, from worktree meta or a folder workspace', () => {
    expect(
      linkedCardForWorktree(
        { getWorktreeMeta: () => ({ linkedWorkItem: item('btk_ok1234') }) as never },
        'wt'
      )
    ).toEqual({ cardId: 'btk_ok1234', cardTitle: 'Card' })
    expect(
      linkedCardForWorktree(
        { getFolderWorkspaces: () => [{ id: 'folder', linkedTask: item('btk_folder1') }] as never },
        'folder'
      )
    ).toEqual({ cardId: 'btk_folder1', cardTitle: 'Card' })
  })

  it('never infers a card: no link, an unadmitted link, or a malformed id is null', () => {
    expect(
      linkedCardForWorktree({ getWorktreeMeta: () => undefined }, 'feat/btk_1234-branch')
    ).toBeNull()
    expect(
      linkedCardForWorktree({ getWorktreeMeta: () => ({ linkedWorkItem: item() }) as never }, 'wt')
    ).toBeNull()
    expect(
      linkedCardForWorktree(
        { getWorktreeMeta: () => ({ linkedWorkItem: item('task-42') }) as never },
        'wt'
      )
    ).toBeNull()
    expect(
      linkedCardForWorktree(
        {
          getWorktreeMeta: () => {
            throw new Error('store closed')
          }
        },
        'wt'
      )
    ).toBeNull()
  })
})
