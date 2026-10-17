import { describe, expect, it } from 'vitest'
import type { SessionLink } from '../../../shared/session-links'
import { buildFilesAndLinksCards } from './session-files-and-links'
import { filesAndLinksView } from './session-files-and-links-result'

function link(url: string, kind: SessionLink['kind'], messageIndex: number): SessionLink {
  return { url, kind, key: url, messageIndex }
}

function pr(number: number, messageIndex: number): SessionLink {
  return {
    ...link(`https://github.com/acme/site/pull/${number}`, 'pull-request', messageIndex),
    pullRequest: { owner: 'acme', repo: 'site', number }
  }
}

function view(args: {
  links?: SessionLink[]
  files?: { path: string; messageIndex: number }[]
  liveness?: Map<string, 'live' | 'stopped' | 'unverifiable'>
}) {
  return filesAndLinksView(
    buildFilesAndLinksCards({
      review: null,
      files: args.files ?? [],
      links: args.links ?? [],
      worktreePath: '/repo'
    }),
    args.liveness
  )
}

describe('filesAndLinksView', () => {
  it('prefers a preview of the session’s own PR over another PR’s preview', () => {
    const { result, counts } = view({
      links: [
        link('https://pr-9.preview.acme.dev/', 'preview', 5),
        link('https://pr-4.preview.acme.dev/app', 'preview', 3),
        pr(4, 2)
      ]
    })
    expect(result).toMatchObject({ type: 'link', pullRequestNumber: 4 })
    expect(counts).toEqual({ pullRequests: 1, previews: 1, files: 0, other: 0 })
  })

  it('takes whichever is newer of the PR preview and a Claude artifact', () => {
    const { result } = view({
      links: [
        link('https://claude.ai/code/artifact/plan', 'artifact', 8),
        link('https://pr-4.preview.acme.dev/', 'preview', 3),
        pr(4, 2)
      ]
    })
    expect(result).toMatchObject({ type: 'link', kind: 'artifact' })
  })

  it('offers a lone deliverable file, and never source code', () => {
    const { result, counts } = view({
      files: [
        { path: '/repo/src/a.ts', messageIndex: 9 },
        { path: '/repo/report.pdf', messageIndex: 4 }
      ]
    })
    expect(result).toMatchObject({ type: 'file', name: 'report.pdf' })
    expect(counts.files).toBe(1)
  })

  it('offers the folder when several deliverables share it, and folds only those', () => {
    const { result, rest } = view({
      files: [
        { path: '/out/ads/b.png', messageIndex: 7 },
        { path: '/out/ads/notes.ts', messageIndex: 6 },
        { path: '/out/ads/a.png', messageIndex: 5 }
      ]
    })
    expect(result).toMatchObject({
      type: 'folder',
      path: '/out/ads',
      name: 'ads',
      count: 2,
      revealPath: '/out/ads/b.png'
    })
    expect(rest.map((card) => card.key)).toEqual(['file:/out/ads/notes.ts'])
  })

  it('uses a running local server, drops a stopped one, and keeps one it cannot check', () => {
    const liveness = new Map([
      ['http://localhost:5173/', 'live' as const],
      ['http://localhost:4000/', 'stopped' as const]
    ])
    const { result, rest } = view({
      links: [
        link('http://localhost:4000/', 'localhost', 6),
        link('http://localhost:5173/', 'localhost', 5),
        link('http://localhost:8080/', 'localhost', 4)
      ],
      liveness
    })
    expect(result).toMatchObject({ url: 'http://localhost:5173/' })
    expect(rest.map((card) => card.key)).toEqual(['link:http://localhost:8080/'])
  })

  it('groups a preview host’s pages and keeps brand home pages last, never as the Result', () => {
    const { result, rest, counts } = view({
      links: [
        link('https://omnirogue.com', 'preview', 9),
        link('https://pr-2.preview.acme.dev/b', 'preview', 8),
        link('https://pr-2.preview.acme.dev/a', 'preview', 7)
      ]
    })
    expect(result).toMatchObject({ url: 'https://pr-2.preview.acme.dev/b', pages: 2 })
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ site: true })
    expect(counts).toEqual({ pullRequests: 0, previews: 0, files: 0, other: 1 })
  })

  it('falls back to the pull request, and to nothing at all', () => {
    expect(view({ links: [pr(7, 1)] }).result).toMatchObject({ type: 'pull-request', number: 7 })
    expect(view({}).result).toBeNull()
  })

  it('offers a Drive or Notion link as the Result, and counts audio and documents as files to open', () => {
    const service: SessionLink = {
      url: 'https://drive.google.com/drive/folders/ads',
      kind: 'service',
      key: 'https://drive.google.com/drive/folders/ads',
      messageIndex: 9,
      service: 'Google Drive'
    }
    expect(view({ links: [service] }).result).toMatchObject({
      kind: 'service',
      name: 'Google Drive'
    })
    expect(view({ files: [{ path: '/out/voice.mp3', messageIndex: 2 }] }).result).toMatchObject({
      type: 'file',
      kind: 'audio'
    })
    expect(view({ files: [{ path: '/out/deck.pptx', messageIndex: 2 }] }).result).toMatchObject({
      type: 'file',
      kind: 'document'
    })
  })
})
