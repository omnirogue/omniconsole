import { describe, expect, it } from 'vitest'
import type { ArtifactSessionRecord } from '../../../../../shared/artifact-session'
import type { SessionLinkedDocsEntry } from '../../../../../shared/session-linked-docs'
import type { ArtifactSessionTarget } from './session-artifact-association'
import { sessionPanelItems } from './session-panel-items'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const API = 'https://app.omnisi.ai'
const target: ArtifactSessionTarget = { worktreeId: 'wt-1', tabId: 'tab-a', leafId: null }

function published(slug: string, savedAt: number): ArtifactSessionRecord {
  return {
    slug,
    shareUrl: `${API}/a/${slug}`,
    sourceKey: `/repo/${slug}.html`,
    savedAt,
    contentUrl: `${API}/a/${slug}/content`,
    origin: { paneKey: `tab-a:${LEAF_A}` }
  }
}

function linked(paneKey: string, docs: SessionLinkedDocsEntry['docs']): SessionLinkedDocsEntry {
  return { paneKey, docs, apiOrigin: API }
}

describe('sessionPanelItems', () => {
  it('shows the session’s linked Slite docs and omnios pages with its published pages, newest first', () => {
    const items = sessionPanelItems(
      [published('mine', 10)],
      [
        linked(`tab-a:${LEAF_A}`, [
          {
            kind: 'slite',
            id: 'AAAAAAAAAAAAAA',
            url: 'https://example.slite.com/app/docs/AAAAAAAAAAAAAA',
            seenAt: 30
          },
          { kind: 'omnios', slug: 'other-model', url: `${API}/a/other-model`, seenAt: 20 }
        ]),
        linked(`tab-b:${LEAF_A}`, [
          {
            kind: 'slite',
            id: 'BBBBBBBBBBBBBB',
            url: 'https://example.slite.com/app/docs/BBBBBBBBBBBBBB',
            seenAt: 40
          }
        ])
      ],
      target
    )
    expect(items.map((item) => item.key)).toEqual([
      'slite:AAAAAAAAAAAAAA',
      'artifact:other-model',
      'artifact:mine'
    ])
    const linkedPage = items[1]
    expect(linkedPage.kind === 'artifact' && linkedPage.record.contentUrl).toBe(
      `${API}/a/other-model/content`
    )
  })

  it('merges a published page with a later link to it, keeping its file name', () => {
    const items = sessionPanelItems(
      [published('mine', 10)],
      [
        linked(`tab-a:${LEAF_A}`, [
          { kind: 'omnios', slug: 'mine', url: `${API}/a/mine`, seenAt: 50 }
        ])
      ],
      target
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'artifact',
      at: 50,
      record: { sourceKey: '/repo/mine.html' }
    })
  })

  it('shows nothing when no conversation is on screen', () => {
    expect(sessionPanelItems([published('mine', 1)], [], null)).toEqual([])
  })
})
