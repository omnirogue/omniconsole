import { describe, expect, it } from 'vitest'
import type { SessionLink } from '../../../shared/session-links'
import {
  buildFilesAndLinksCards,
  resolveSessionFilePath,
  shortFileLocation,
  withKnownPullRequestState
} from './session-files-and-links'

function link(
  url: string,
  kind: SessionLink['kind'],
  messageIndex: number,
  pullRequest?: SessionLink['pullRequest']
): SessionLink {
  return { url, kind, key: url, messageIndex, ...(pullRequest ? { pullRequest } : {}) }
}

const review = {
  number: 42,
  url: 'https://github.com/acme/site/pull/42',
  state: 'open' as const,
  status: 'success' as const
}

describe('buildFilesAndLinksCards', () => {
  it('puts the workspace PR first, then files and links newest first', () => {
    const cards = buildFilesAndLinksCards({
      review,
      files: [
        { path: '/repo/site/index.html', messageIndex: 5 },
        { path: '/repo/site/shot.png', messageIndex: 1 }
      ],
      links: [
        link('http://localhost:3000/', 'localhost', 7),
        link('https://claude.ai/artifact/abc', 'artifact', 3)
      ],
      worktreePath: '/repo/site'
    })
    expect(cards.map((card) => card.key)).toEqual([
      'pr:acme/site#42',
      'link:http://localhost:3000/',
      'file:/repo/site/index.html',
      'link:https://claude.ai/artifact/abc',
      'file:/repo/site/shot.png'
    ])
    expect(cards[0]).toMatchObject({ type: 'pull-request', state: 'open', checks: 'success' })
  })

  it('folds a transcript link to the workspace PR into its card and keeps other PRs', () => {
    const cards = buildFilesAndLinksCards({
      review,
      files: [],
      links: [
        link('https://github.com/acme/site/pull/42', 'pull-request', 9, {
          owner: 'acme',
          repo: 'site',
          number: 42
        }),
        link('https://github.com/acme/api/pull/42', 'pull-request', 4, {
          owner: 'acme',
          repo: 'api',
          number: 42
        })
      ],
      worktreePath: null
    })
    expect(cards.map((card) => card.key)).toEqual(['pr:acme/site#42', 'pr:acme/api#42'])
    expect(cards[1]).not.toHaveProperty('state')
  })

  it('shows the workspace PR in one session’s own view only when its transcript links it', () => {
    const own = { review, files: [], worktreePath: '/repo/site', reviewOnlyWhenLinked: true }
    expect(buildFilesAndLinksCards({ ...own, links: [] })).toEqual([])
    const linked = buildFilesAndLinksCards({
      ...own,
      links: [
        link('https://github.com/acme/site/pull/42', 'pull-request', 3, {
          owner: 'acme',
          repo: 'site',
          number: 42
        })
      ]
    })
    expect(linked).toEqual([expect.objectContaining({ key: 'pr:acme/site#42', state: 'open' })])
  })

  it('never takes a review for another one because their numbers match', () => {
    const gitlab = {
      number: 42,
      url: 'https://gitlab.com/acme/site/-/merge_requests/42',
      state: 'open' as const,
      status: 'success' as const
    }
    const otherRepoPr = link('https://github.com/other/repo/pull/42', 'pull-request', 2, {
      owner: 'other',
      repo: 'repo',
      number: 42
    })
    const own = { files: [], worktreePath: null, reviewOnlyWhenLinked: true }
    expect(
      buildFilesAndLinksCards({ ...own, review: gitlab, links: [otherRepoPr] }).map((c) => c.key)
    ).toEqual(['pr:other/repo#42'])
    // The same MR linked by its address is the workspace review, listed once with its state.
    const linked = buildFilesAndLinksCards({
      ...own,
      review: gitlab,
      links: [link('https://gitlab.com/acme/site/-/merge_requests/42/', 'service', 3)]
    })
    expect(linked).toEqual([expect.objectContaining({ type: 'pull-request', state: 'open' })])
  })

  it('shows a transcript PR on its own when the workspace has no known review', () => {
    const cards = buildFilesAndLinksCards({
      review: null,
      files: [{ path: '/repo/a.ts', messageIndex: 10 }],
      links: [
        link('https://github.com/acme/site/pull/7', 'pull-request', 2, {
          owner: 'acme',
          repo: 'site',
          number: 7
        })
      ],
      worktreePath: '/repo'
    })
    expect(cards.map((card) => card.type)).toEqual(['pull-request', 'file'])
  })

  it('classifies each file and names it with a short location', () => {
    const [card] = buildFilesAndLinksCards({
      review: null,
      files: [{ path: '/repo/public/img/hero.webp', messageIndex: 0 }],
      links: [],
      worktreePath: '/repo'
    })
    expect(card).toMatchObject({
      type: 'file',
      kind: 'image',
      name: 'hero.webp',
      location: 'public/img'
    })
  })
})

describe('file paths', () => {
  it('resolves workspace-relative paths and leaves absolute ones', () => {
    expect(resolveSessionFilePath('src/a.ts', '/repo/')).toBe('/repo/src/a.ts')
    expect(resolveSessionFilePath('./a.ts', '/repo')).toBe('/repo/a.ts')
    expect(resolveSessionFilePath('/tmp/a.ts', '/repo')).toBe('/tmp/a.ts')
    expect(resolveSessionFilePath('a.ts', null)).toBeNull()
  })

  it('shortens locations outside the workspace to their last two folders', () => {
    expect(shortFileLocation('/Users/maintainer/Work/Out/Ads/a.png', '/repo')).toBe('…/Out/Ads')
    expect(shortFileLocation('/repo/a.png', '/repo')).toBe('')
  })
})

describe('withKnownPullRequestState', () => {
  it('fills a transcript PR’s state and checks from facts already read, never overriding', () => {
    const cards = buildFilesAndLinksCards({
      review,
      files: [],
      links: [
        link('https://github.com/acme/api/pull/7', 'pull-request', 1, {
          owner: 'acme',
          repo: 'api',
          number: 7
        })
      ],
      worktreePath: null
    })
    const known = new Map([
      ['acme/api#7', { state: 'draft' as const, checks: 'failure' as const }],
      ['acme/site#42', { state: 'closed' as const, checks: 'neutral' as const }]
    ])
    expect(withKnownPullRequestState(cards, known)).toMatchObject([
      { key: 'pr:acme/site#42', state: 'open', checks: 'success' },
      { key: 'pr:acme/api#7', state: 'draft', checks: 'failure' }
    ])
  })
})
