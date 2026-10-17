import { describe, expect, it } from 'vitest'
import { IGNORABLE } from './invisible-characters'

describe('IGNORABLE', () => {
  it('matches tag characters, zero-width characters, bidi controls and soft hyphens', () => {
    const hidden =
      'a\u{E0041}\u{E007F}b\u200b\u200c\u200d\u2060\ufeffc\u202a\u202e\u2066\u2069\u200e\u200fd\u00ade'
    expect(hidden.replace(IGNORABLE, '')).toBe('abcde')
  })

  it('leaves visible letters, spaces and line breaks alone', () => {
    const visible = 'Plain text, \u00e9t\u00e9 \u4e2d\u6587\n\ttabbed'
    expect(visible.replace(IGNORABLE, '')).toBe(visible)
  })
})
