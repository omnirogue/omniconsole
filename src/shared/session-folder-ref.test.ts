import { describe, expect, it } from 'vitest'
import {
  resolveSessionFolderRef,
  SAVED_SESSIONS_REF_ID,
  sessionFolderDisplayPath,
  type SessionFolderRefNode
} from './session-folder-ref'

const folders: SessionFolderRefNode[] = [
  { id: 'clients', name: 'Clients' },
  { id: 'acme', name: 'Acme', parentId: 'clients' },
  { id: 'q3-acme', name: 'Q3', parentId: 'acme' },
  { id: 'sales', name: 'Sales' },
  { id: 'q3-sales', name: 'Q3', parentId: 'sales' },
  { id: 'archive', name: 'Archive', section: 'saved' },
  { id: 'x', name: 'X', section: 'saved', parentId: 'archive' }
]

function resolvedId(ref: string): string | null {
  const result = resolveSessionFolderRef(folders, ref)
  if (!result.ok) {
    return null
  }
  return result.target.kind === 'folder' ? result.target.folder.id : 'saved-root'
}

describe('resolveSessionFolderRef', () => {
  it('takes an id as is', () => {
    expect(resolvedId('acme')).toBe('acme')
  })

  it('resolves a full path with either separator, ignoring case', () => {
    expect(resolvedId('Clients / Acme / Q3')).toBe('q3-acme')
    expect(resolvedId('clients/acme/q3')).toBe('q3-acme')
    expect(resolvedId('  Sales /Q3 ')).toBe('q3-sales')
  })

  it('addresses Saved Sessions by its label or id', () => {
    expect(resolvedId('Saved Sessions / Archive / X')).toBe('x')
    expect(resolvedId('saved sessions/x')).toBe('x')
    expect(resolvedId('Saved Sessions')).toBe('saved-root')
    expect(resolvedId(SAVED_SESSIONS_REF_ID)).toBe('saved-root')
  })

  it('does not look outside Saved Sessions for a saved path', () => {
    const result = resolveSessionFolderRef(folders, 'Saved Sessions / Sales')
    expect(result.ok).toBe(false)
  })

  it('finds a unique last part of a path', () => {
    expect(resolvedId('Acme')).toBe('acme')
    expect(resolvedId('Acme / Q3')).toBe('q3-acme')
    expect(resolvedId('X')).toBe('x')
  })

  it('prefers a folder at the top over a deeper one with the same tail', () => {
    const withTop = [...folders, { id: 'top-q3', name: 'Q3' }]
    const result = resolveSessionFolderRef(withTop, 'Q3')
    expect(result.ok && result.target.kind === 'folder' && result.target.folder.id).toBe('top-q3')
  })

  it('lists the candidates of an ambiguous name', () => {
    const result = resolveSessionFolderRef(folders, 'q3')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('matches 2 folders')
    expect(!result.ok && result.error).toContain('"Clients / Acme / Q3" (q3-acme)')
    expect(!result.ok && result.error).toContain('"Sales / Q3" (q3-sales)')
  })

  it('lists every folder when nothing matches', () => {
    const result = resolveSessionFolderRef(folders, 'Nope')
    expect(!result.ok && result.error).toContain('No folder matches "Nope"')
    expect(!result.ok && result.error).toContain('"Saved Sessions / Archive / X" (x)')
    expect(resolveSessionFolderRef([], 'Nope')).toEqual({
      ok: false,
      error: 'No folder matches "Nope": there are no folders yet.'
    })
  })

  it('refuses an empty reference', () => {
    expect(resolveSessionFolderRef(folders, '  ').ok).toBe(false)
    expect(resolveSessionFolderRef(folders, ' / ').ok).toBe(false)
  })

  it('matches a name that itself holds a slash', () => {
    const slashed = [{ id: 'ab', name: 'A/B' }]
    expect(resolveSessionFolderRef(slashed, 'a / b')).toEqual({
      ok: true,
      target: { kind: 'folder', folder: slashed[0] }
    })
  })
})

describe('sessionFolderDisplayPath', () => {
  it('prefixes saved folders with Saved Sessions', () => {
    expect(sessionFolderDisplayPath(folders, folders[2]!)).toBe('Clients / Acme / Q3')
    expect(sessionFolderDisplayPath(folders, folders[6]!)).toBe('Saved Sessions / Archive / X')
  })
})
