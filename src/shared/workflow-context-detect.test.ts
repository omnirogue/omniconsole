import { describe, expect, it } from 'vitest'
import { workflowContextPrefill, workflowContextSourcesIn } from './workflow-context-detect'

describe('the files, folders and repos a request names', () => {
  it('finds absolute and home paths without the punctuation around them', () => {
    expect(
      workflowContextSourcesIn(
        'Compare /Users/maintainer/Work/notes.md with ~/Documents/plans, and (see /srv/app/config.yaml).'
      )
    ).toEqual([
      { kind: 'path', path: '/Users/maintainer/Work/notes.md' },
      { kind: 'path', path: '~/Documents/plans' },
      { kind: 'path', path: '/srv/app/config.yaml' }
    ])
  })

  it('keeps a quoted path with spaces whole', () => {
    expect(workflowContextSourcesIn('Read "~/Library/Mobile Documents/brief.txt" first')).toEqual([
      { kind: 'path', path: '~/Library/Mobile Documents/brief.txt' }
    ])
  })

  it('leaves out single-segment slashes and the paths inside web addresses', () => {
    expect(
      workflowContextSourcesIn('Spend $800 /day and/or check https://example.com/a/b and ~/')
    ).toEqual([])
  })

  it('finds github.com addresses, with a /tree/ branch when there is one', () => {
    expect(
      workflowContextSourcesIn(
        'Look at https://github.com/omnirogue/omni-ide/tree/main-next and github.com/vercel/next.js.'
      )
    ).toEqual([
      { kind: 'github', repo: 'omnirogue/omni-ide', ref: 'main-next' },
      { kind: 'github', repo: 'vercel/next.js' }
    ])
  })

  it('reads a branch with slashes and drops a .git suffix', () => {
    expect(
      workflowContextSourcesIn(
        'https://github.com/acme/api.git and https://github.com/acme/web/tree/feat/login'
      )
    ).toEqual([
      { kind: 'github', repo: 'acme/api' },
      { kind: 'github', repo: 'acme/web', ref: 'feat/login' }
    ])
  })

  it('never takes github.com pages that are not repositories', () => {
    expect(
      workflowContextSourcesIn('https://github.com/settings/tokens https://github.com/orgs/acme')
    ).toEqual([])
  })

  it('takes a bare owner/name only when the text calls it a repo', () => {
    expect(workflowContextSourcesIn('Review the repo omnirogue/omni-ide please')).toEqual([
      { kind: 'github', repo: 'omnirogue/omni-ide' }
    ])
    expect(workflowContextSourcesIn('Check the acme/api repository.')).toEqual([
      { kind: 'github', repo: 'acme/api' }
    ])
    expect(workflowContextSourcesIn('Weigh input/output and pros/cons for acme/api')).toEqual([])
  })

  it('names each source once, in the order the text names it', () => {
    expect(
      workflowContextSourcesIn(
        'github acme/api, then ~/a/b, then https://github.com/acme/api again and ~/a/b'
      )
    ).toEqual([
      { kind: 'github', repo: 'acme/api' },
      { kind: 'path', path: '~/a/b' }
    ])
  })
})

describe('offering what a request names', () => {
  it('adds only what is new and was never removed', () => {
    const chosen = [{ kind: 'path' as const, path: '~/a/b' }]
    const dismissed = new Set(['github:acme/api@'])
    expect(workflowContextPrefill('Use ~/a/b, repo acme/api and ~/c/d', chosen, dismissed)).toEqual(
      [
        { kind: 'path', path: '~/a/b' },
        { kind: 'path', path: '~/c/d' }
      ]
    )
  })

  it('offers nothing when nothing is new', () => {
    expect(workflowContextPrefill('Use ~/a/b', [{ kind: 'path', path: '~/a/b' }], new Set())).toBe(
      undefined
    )
    expect(workflowContextPrefill('Use ~/a/b', [], new Set(['path:~/a/b']))).toBe(undefined)
  })
})
