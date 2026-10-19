import { describe, expect, it } from 'vitest'
import { sessionDocumentLink } from './session-document-link'

const origin = 'https://console.example.com'

describe('explicit session document links', () => {
  it('recognizes exact Slite and configured artifact routes', () => {
    expect(
      sessionDocumentLink('https://example.slite.com/app/docs/X3P_WfcLxXPaiG', origin)?.kind
    ).toBe('slite')
    const item = sessionDocumentLink(`${origin}/a/1a0d30b4f32c7abb9`, origin)
    expect(item?.kind).toBe('artifact')
    if (item?.kind === 'artifact') {
      expect(item.record.origin).toBeNull()
      expect(item.record.contentUrl).toBe(`${origin}/a/1a0d30b4f32c7abb9/content`)
    }
  })
  it('leaves lookalikes, credentials, operations and other instances to normal routing', () => {
    for (const url of [
      `${origin}.evil.test/a/1a0d30b4f32c7abb9`,
      'https://other.test/a/1a0d30b4f32c7abb9',
      'https://user@console.example.com/a/1a0d30b4f32c7abb9',
      `${origin}/a/1a0d30b4f32c7abb9/content`,
      `${origin}/a/1a0d30b4f32c7abb9?download=1`,
      'http://example.slite.com/app/docs/X3P_WfcLxXPaiG',
      'https://example.slite.com.evil.test/app/docs/X3P_WfcLxXPaiG'
    ]) {
      expect(sessionDocumentLink(url, origin)).toBeNull()
    }
  })
})
