import { describe, expect, it } from 'vitest'
import { revertSessionFolderChange } from './session-folder-cli-undo'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolderMetadata } from './session-folders'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

function metadata(partial: Partial<SessionFolderMetadata>): SessionFolderMetadata {
  return { version: 1, folders: [], membership: {}, ...partial }
}

describe('revertSessionFolderChange', () => {
  it('returns the earlier state when nothing changed since', () => {
    const before = metadata({ folders: [{ id: A, name: 'A' }] })
    const after = metadata({
      folders: [
        { id: A, name: 'A' },
        { id: B, name: 'B' }
      ]
    })
    expect(revertSessionFolderChange(after, before, after)).toBe(before)
  })

  it('removes a created folder but keeps later, unrelated changes', () => {
    const before = metadata({ folders: [{ id: A, name: 'A' }] })
    const after = metadata({
      folders: [
        { id: A, name: 'A' },
        { id: B, name: 'B' }
      ]
    })
    const current = metadata({
      folders: [
        { id: A, name: 'A' },
        { id: B, name: 'B' },
        { id: C, name: 'C' }
      ],
      membership: { s1: C }
    })
    expect(revertSessionFolderChange(current, before, after)).toEqual(
      metadata({
        folders: [
          { id: A, name: 'A' },
          { id: C, name: 'C' }
        ],
        membership: { s1: C }
      })
    )
  })

  it('puts a moved branch back, sections included', () => {
    const before = metadata({
      folders: [
        { id: A, name: 'A' },
        { id: B, name: 'B', section: 'saved' },
        { id: C, name: 'C', section: 'saved', parentId: B }
      ]
    })
    const after = metadata({
      folders: [
        { id: A, name: 'A' },
        { id: B, name: 'B', parentId: A },
        { id: C, name: 'C', parentId: B }
      ]
    })
    const current = { ...after, finishActions: {} }
    expect(revertSessionFolderChange(current, before, after)).toEqual({
      ...before,
      finishActions: {}
    })
  })

  it('restores a moved session membership, and drops one that was added', () => {
    const before = metadata({ folders: [{ id: A, name: 'A' }], membership: { s1: A } })
    const after = metadata({
      folders: [{ id: A, name: 'A' }],
      membership: { s1: SAVED_SESSIONS_FOLDER_ID, s2: A }
    })
    const current = { ...after, membership: { ...after.membership, s3: A } }
    expect(revertSessionFolderChange(current, before, after)?.membership).toEqual({
      s1: A,
      s3: A
    })
  })

  it('refuses when a later change filed something in the folder it would remove', () => {
    const before = metadata({})
    const after = metadata({ folders: [{ id: A, name: 'A' }] })
    const current = metadata({ folders: [{ id: A, name: 'A' }], membership: { s1: A } })
    expect(revertSessionFolderChange(current, before, after)).toBeNull()
  })

  it('refuses when a later folder took the name the rename would restore', () => {
    const before = metadata({ folders: [{ id: A, name: 'Old' }] })
    const after = metadata({ folders: [{ id: A, name: 'New' }] })
    const current = metadata({
      folders: [
        { id: A, name: 'New' },
        { id: B, name: 'old' }
      ]
    })
    expect(revertSessionFolderChange(current, before, after)).toBeNull()
  })
})
