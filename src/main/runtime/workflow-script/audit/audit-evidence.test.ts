import { describe, expect, it, vi } from 'vitest'
import { buildAuditCorpus, type AuditSource } from './audit-corpus'
import { verifyAuditEvidence } from './audit-evidence'

const sources: AuditSource[] = [
  { id: 'one', timestamp: '2026-10-02T12:00:00Z', text: 'The build failed. Retrying now.' },
  { id: 'two', timestamp: '2026-10-02T12:01:00Z', text: 'The release is ready.' }
]
const manifest = buildAuditCorpus(sources, { maxChunkBytes: 10_000 }).sources
const load = async (id: string) => sources.find((source) => source.id === id) ?? null

describe('audit evidence verification', () => {
  it('re-reads registered originals and counts distinct verified sources rather than quotes', async () => {
    const loader = vi.fn(load)
    const result = await verifyAuditEvidence(
      [
        { sourceId: 'one', quote: 'The build failed.' },
        { sourceId: 'one', quote: 'Retrying now.' },
        { sourceId: 'two', quote: 'The release is ready.' }
      ],
      manifest,
      loader
    )
    expect(result.citedSourceCount).toBe(2)
    expect(result.verifiedSourceCount).toBe(2)
    expect(result.allVerified).toBe(true)
    expect(loader.mock.calls).toEqual([['one'], ['two']])
  })

  it('does not accept a real quote from a different ID, a header, or normalized text', async () => {
    const result = await verifyAuditEvidence(
      [
        { sourceId: 'two', quote: 'The build failed.' },
        { sourceId: 'one', quote: 'SOURCE one' },
        { sourceId: 'one', quote: 'the build failed.' },
        { sourceId: 'one', quote: 'The  build failed.' }
      ],
      manifest,
      load
    )
    expect(result.citations.every((citation) => citation.status === 'quote-not-found')).toBe(true)
    expect(result.verifiedSourceCount).toBe(0)
    expect(result.allVerified).toBe(false)
  })

  it('never passes model supplied paths or unregistered IDs to the loader', async () => {
    const loader = vi.fn(load)
    const result = await verifyAuditEvidence(
      [
        { sourceId: '../../secrets', quote: 'secret' },
        { sourceId: 'unknown', quote: 'The build failed.' },
        { sourceId: 'one', quote: '' },
        { sourceId: 'one', quote: '  \n' }
      ],
      manifest,
      loader
    )
    expect(result.citations.map((citation) => citation.status)).toEqual([
      'source-not-registered',
      'source-not-registered',
      'invalid-quote',
      'invalid-quote'
    ])
    expect(loader).not.toHaveBeenCalled()
  })

  it('distinguishes missing, unreadable, mismatched and changed originals', async () => {
    const citation = [{ sourceId: 'one', quote: 'The build failed.' }]
    expect(
      (await verifyAuditEvidence(citation, manifest, async () => null)).citations[0].status
    ).toBe('source-missing')
    expect(
      (
        await verifyAuditEvidence(citation, manifest, async () => {
          throw new Error('offline')
        })
      ).citations[0].status
    ).toBe('source-unreadable')
    expect(
      (await verifyAuditEvidence(citation, manifest, async () => sources[1])).citations[0].status
    ).toBe('source-id-mismatch')
    for (const patch of [
      { text: `${sources[0].text} Later edit.` },
      { timestamp: '2026-10-03T12:00:00Z' },
      { timestamp: 'invalid' }
    ]) {
      const result = await verifyAuditEvidence(citation, manifest, async () => ({
        ...sources[0],
        ...patch
      }))
      expect(result.citations[0].status).toBe('source-changed')
      expect(result.verifiedSourceCount).toBe(0)
    }
  })

  it('does not claim verification for empty evidence and rejects ambiguous registries', async () => {
    expect(await verifyAuditEvidence([], manifest, load)).toEqual({
      citations: [],
      citedSourceCount: 0,
      verifiedSourceCount: 0,
      allVerified: false
    })
    await expect(verifyAuditEvidence([], [...manifest, manifest[0]], load)).rejects.toThrow(
      'Duplicate IDs'
    )
  })
})
