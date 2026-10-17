import { describe, expect, it } from 'vitest'
import { readSessionOwnerTitle, sessionOwnerTitle } from './session-owner-title'

describe('sessionOwnerTitle', () => {
  const vault = { agent: 'claude', sessionId: 's-1', title: 'Agent name' } as const

  it('follows the owner sidebar: rename, pane title, generated, then agent title', () => {
    const tab = { customTitle: ' Renamed ', generatedTitle: 'Generated', aiVaultTitle: vault }
    expect(sessionOwnerTitle(tab, 'Pane')).toBe('Renamed')
    expect(sessionOwnerTitle({ ...tab, customTitle: null }, 'Pane')).toBe('Pane')
    expect(sessionOwnerTitle({ ...tab, customTitle: null }, ' ')).toBe('Generated')
    expect(sessionOwnerTitle({ customTitle: null, aiVaultTitle: vault }, null)).toBe('Agent name')
  })

  it('has no name for a pane known only by its live terminal title', () => {
    expect(sessionOwnerTitle({ customTitle: null }, undefined)).toBeUndefined()
  })
})

describe('readSessionOwnerTitle', () => {
  it('reads a name and treats anything else as absent', () => {
    expect(readSessionOwnerTitle(' Studio name ')).toBe('Studio name')
    expect(readSessionOwnerTitle('  ')).toBeUndefined()
    expect(readSessionOwnerTitle(undefined)).toBeUndefined()
    expect(readSessionOwnerTitle(7)).toBeUndefined()
  })
})
