import { describe, expect, it } from 'vitest'
import {
  SESSION_SEARCH_MARK_CLOSE as CLOSE,
  SESSION_SEARCH_MARK_OPEN as OPEN
} from '../../../../../shared/session-search-types'
import { sessionSearchPreview, SESSION_SEARCH_PREVIEW_MAX_CHARS } from './session-search-preview'

const visible = (text: string): string => text.replaceAll(OPEN, '').replaceAll(CLOSE, '')

describe('sessionSearchPreview', () => {
  it('keeps a late search match visible without displaying a long remote message', () => {
    const preview = sessionSearchPreview(
      {
        snippets: [
          {
            role: 'assistant',
            text: `${'unrelated paragraph\n\n'.repeat(20)}${OPEN}archive recovery${CLOSE} restores sessions. ${'extra '.repeat(100)}`
          }
        ],
        summary: 'The full summary must not replace the matching passage.'
      },
      'archive recovery'
    )

    expect(preview).toContain(`${OPEN}archive recovery${CLOSE} restores sessions.`)
    expect(visible(preview).length).toBeLessThanOrEqual(SESSION_SEARCH_PREVIEW_MAX_CHARS)
    expect(preview.indexOf(OPEN)).toBeLessThanOrEqual(41)
    expect(preview).not.toMatch(/\n|full summary/)
  })

  it('shows the relevant summary passage when only the summary matched', () => {
    const preview = sessionSearchPreview(
      {
        snippets: [],
        summary: `${'Earlier unrelated work. '.repeat(30)}Fixed database backups for the customer. ${'Later unrelated work. '.repeat(30)}`
      },
      'database backups'
    )

    expect(preview).toContain(`${OPEN}database backups${CLOSE} for the customer.`)
    expect(visible(preview).length).toBeLessThanOrEqual(SESSION_SEARCH_PREVIEW_MAX_CHARS)
  })

  it('bounds a meaning-only summary without inventing a literal match', () => {
    const preview = sessionSearchPreview(
      { snippets: [], summary: 'Reduced waiting time.\n\n'.repeat(40) },
      'latency'
    )
    expect(preview).toMatch(/^Reduced waiting time\./)
    expect(preview).not.toContain(OPEN)
    expect(preview).not.toContain('\n')
    expect(visible(preview).length).toBeLessThanOrEqual(SESSION_SEARCH_PREVIEW_MAX_CHARS)
  })

  it('bounds an oversized marked token and keeps highlights and Unicode intact', () => {
    const preview = sessionSearchPreview(
      { snippets: [{ role: 'user', text: `${OPEN}${'🚀'.repeat(500)}${CLOSE}` }], summary: null },
      'launch'
    )
    expect(visible(preview).length).toBeLessThanOrEqual(SESSION_SEARCH_PREVIEW_MAX_CHARS)
    expect(visible(preview).isWellFormed()).toBe(true)
    expect(preview.match(new RegExp(OPEN, 'g'))).toHaveLength(1)
    expect(preview.match(new RegExp(CLOSE, 'g'))).toHaveLength(1)
  })

  it('uses a matching snippet after an empty result and handles absent evidence', () => {
    expect(
      sessionSearchPreview(
        {
          snippets: [
            { role: 'user', text: '  ' },
            { role: 'assistant', text: `${OPEN}found${CLOSE}` }
          ],
          summary: null
        },
        'found'
      )
    ).toBe(`${OPEN}found${CLOSE}`)
    expect(sessionSearchPreview({ snippets: [], summary: null }, 'anything')).toBe('')
  })
})
