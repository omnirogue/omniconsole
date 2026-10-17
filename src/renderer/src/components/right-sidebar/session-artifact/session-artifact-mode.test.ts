import { describe, expect, it } from 'vitest'
import { isArtifactModeActive, pickSessionArtifact } from './session-artifact-mode'

describe('isArtifactModeActive', () => {
  it('never shows Session work without a session on screen', () => {
    expect(isArtifactModeActive(true, false)).toBe(false)
    expect(isArtifactModeActive(false, false)).toBe(false)
  })

  it('follows the person’s last pick between Session work and a developer tab', () => {
    expect(isArtifactModeActive(true, true)).toBe(true)
    expect(isArtifactModeActive(false, true)).toBe(false)
  })
})

describe('pickSessionArtifact', () => {
  const items = [{ key: 'newest' }, { key: 'older' }]

  it('shows the most recent item by default', () => {
    expect(pickSessionArtifact(items, null)?.key).toBe('newest')
  })

  it('keeps the picked item while it is still the session’s', () => {
    expect(pickSessionArtifact(items, 'older')?.key).toBe('older')
  })

  it('falls back to the most recent when the pick is gone', () => {
    expect(pickSessionArtifact(items, 'deleted')?.key).toBe('newest')
    expect(pickSessionArtifact<{ key: string }>([], 'older')).toBeNull()
  })
})
