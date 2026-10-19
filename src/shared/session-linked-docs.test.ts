import { describe, expect, it } from 'vitest'
import {
  extractSessionLinkedDocs,
  mergeSessionLinkedDocs,
  sanitizeSessionLinkedDoc
} from './session-linked-docs'

const API = 'https://app.omnisi.ai'

describe('extractSessionLinkedDocs', () => {
  it('finds Slite docs and omnios pages in reply order, the last one newest', () => {
    const reply = [
      'Plan: https://example.slite.com/app/docs/p7qESgZFFXYZsv/PLAN-Launch?search=x',
      `Review it at ${API}/a/1a0cf801270479643.`
    ].join('\n')
    expect(extractSessionLinkedDocs(reply, API, 100)).toEqual([
      {
        kind: 'slite',
        id: 'p7qESgZFFXYZsv',
        url: 'https://example.slite.com/app/docs/p7qESgZFFXYZsv',
        seenAt: 100
      },
      { kind: 'omnios', slug: '1a0cf801270479643', url: `${API}/a/1a0cf801270479643`, seenAt: 101 }
    ])
  })

  it('lists a document once, and ignores lookalike hosts, content URLs and other origins', () => {
    const reply = [
      'https://example.slite.com/app/docs/AAAAAAAAAAAAAA twice https://example.slite.com/app/docs/AAAAAAAAAAAAAA',
      'https://slite.com.evil.example/app/docs/BBBBBBBBBBBBBB',
      `${API}/a/abc/content`,
      'https://omnios.example.com/a/zzz'
    ].join(' ')
    expect(extractSessionLinkedDocs(reply, API, 1).map((doc) => doc.kind)).toEqual(['slite'])
  })

  it('still finds Slite docs when the omnios origin is unknown', () => {
    const reply = `${API}/a/abc and https://example.slite.com/app/docs/CCCCCCCCCCCCCC`
    expect(extractSessionLinkedDocs(reply, null, 1).map((doc) => doc.kind)).toEqual(['slite'])
  })
})

describe('mergeSessionLinkedDocs', () => {
  it('keeps one entry per document, newest first, capped', () => {
    const a = { kind: 'slite', id: 'AAAAAAAAAAAAAA', url: 'u', seenAt: 1 } as const
    const b = { kind: 'omnios', slug: 'b', url: 'u', seenAt: 2 } as const
    const aAgain = { ...a, seenAt: 3 }
    expect(mergeSessionLinkedDocs([a, b], [aAgain], 5)).toEqual([aAgain, b])
    expect(mergeSessionLinkedDocs([a, b], [aAgain], 1)).toEqual([aAgain])
  })
})

describe('sanitizeSessionLinkedDoc', () => {
  it('drops malformed entries instead of failing', () => {
    expect(sanitizeSessionLinkedDoc(null)).toBeNull()
    expect(sanitizeSessionLinkedDoc({ kind: 'slite', id: 'x', url: 'u', seenAt: 1 })).toBeNull()
    expect(
      sanitizeSessionLinkedDoc({
        kind: 'slite',
        id: 'AAAAAAAAAAAAAA',
        url: 'https://evil.example/app/docs/AAAAAAAAAAAAAA',
        seenAt: 1
      })
    ).toBeNull()
    expect(
      sanitizeSessionLinkedDoc({ kind: 'omnios', slug: 'ok', url: `${API}/a/ok`, seenAt: 2 })
    ).toEqual({ kind: 'omnios', slug: 'ok', url: `${API}/a/ok`, seenAt: 2 })
  })
})
