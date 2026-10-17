import { describe, expect, it } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { keepRowsMutatedAfterRequest } from './artifact-list-fence'

const row = (slug: string, lifecycle: 'done' | null): ArtifactListItem => ({
  artifact: {
    version: 1,
    slug,
    title: slug,
    originalFileName: null,
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '',
    updatedAt: '',
    expiresAt: '',
    byteSize: 1,
    deletedAt: null,
    lifecycle
  },
  shareUrl: `https://omnios.example/a/${slug}`
})

describe('keepRowsMutatedAfterRequest', () => {
  it('keeps the local row only for pages changed after the request started', () => {
    const merged = keepRowsMutatedAfterRequest(
      [row('a', null), row('b', null), row('c', null)],
      [row('a', 'done'), row('b', 'done')],
      (slug) => slug === 'a' || slug === 'c'
    )
    expect(merged.map((item) => [item.artifact.slug, item.artifact.lifecycle])).toEqual([
      ['a', 'done'],
      ['b', null],
      ['c', null]
    ])
  })
})
