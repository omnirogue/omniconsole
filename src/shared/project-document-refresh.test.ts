import { describe, expect, it, vi } from 'vitest'
import type { SessionContextAttachment } from './session-context-attachments'
import type { ResolveContextDocumentRequest } from './session-context-documents'
import { refreshProjectDocuments } from './project-document-refresh'

const items: SessionContextAttachment[] = [
  { id: 'slite:abc', kind: 'slite', title: 'Plan', uri: 'https://slite/abc', content: 'Old plan' },
  { id: 'omnios:brief-1', kind: 'omnios', title: 'Brief', content: 'Old brief', capturedAt: 1 },
  { id: 'instructions', kind: 'instructions', title: 'Rules', content: 'Be brief' },
  { id: 'skill-name:jira', kind: 'skill', title: 'jira' }
]

describe('refreshProjectDocuments', () => {
  it('re-reads Slite and OmniOS documents and leaves everything else as saved', async () => {
    const resolve = vi.fn(async (request: ResolveContextDocumentRequest) => ({
      status: 'ok' as const,
      document: {
        source: request.source,
        id: request.id,
        title: `${request.id} today`,
        url: `https://docs/${request.id}`,
        content: `Today's ${request.id}`,
        contentType: 'text/markdown' as const,
        capturedAt: 50,
        truncated: false
      }
    }))
    const refreshed = await refreshProjectDocuments(items, resolve)
    expect(resolve.mock.calls.map(([request]) => request)).toEqual([
      { source: 'slite', id: 'abc' },
      { source: 'omnios', id: 'brief-1' }
    ])
    expect(refreshed.notes).toEqual([])
    expect(refreshed.items[0]).toEqual({
      id: 'slite:abc',
      kind: 'slite',
      title: 'abc today',
      uri: 'https://docs/abc',
      content: "Today's abc",
      capturedAt: 50,
      truncated: false
    })
    expect(refreshed.items[1]).toMatchObject({ id: 'omnios:brief-1', content: "Today's brief-1" })
    expect(refreshed.items.slice(2)).toEqual(items.slice(2))
  })

  it('keeps the saved copy of a document that cannot be read, and says why', async () => {
    const resolve = vi.fn(async (request: ResolveContextDocumentRequest) =>
      request.source === 'slite'
        ? { status: 'error' as const, message: 'Add a Slite key in Settings.' }
        : Promise.reject(new Error('offline'))
    )
    const refreshed = await refreshProjectDocuments(items, resolve)
    expect(refreshed.items).toEqual(items)
    expect(refreshed.notes).toEqual([
      'Kept the saved copy of “Plan”: Add a Slite key in Settings.',
      'Kept the saved copy of “Brief”: offline'
    ])
  })
})
