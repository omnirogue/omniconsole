import { describe, expect, it } from 'vitest'
import {
  buildDeliverableContract,
  deliverablePathStyle,
  requestDeliverables,
  resolveDeliverablePath
} from './deliverable-contract'

describe('deliverable paths', () => {
  it('tells Windows and POSIX workspaces apart', () => {
    expect(deliverablePathStyle('C:\\work\\repo')).toBe('win32')
    expect(deliverablePathStyle('\\\\server\\share')).toBe('win32')
    expect(deliverablePathStyle('/home/me/repo')).toBe('posix')
  })

  it('resolves relative, absolute and home paths by the host rules', () => {
    expect(resolveDeliverablePath('docs/a.md', '/repo', 'posix', null)).toBe('/repo/docs/a.md')
    expect(resolveDeliverablePath('/tmp/a.md', '/repo', 'posix', null)).toBe('/tmp/a.md')
    expect(resolveDeliverablePath('~/a.md', '/repo', 'posix', '/home/me')).toBe('/home/me/a.md')
    expect(resolveDeliverablePath('~/a.md', '/repo', 'posix', null)).toBeNull()
    expect(resolveDeliverablePath('docs\\a.md', 'C:\\repo', 'win32', null)).toBe(
      'C:\\repo\\docs\\a.md'
    )
  })
})

describe('requestDeliverables', () => {
  it('tags request, Done when and mission items', () => {
    const prompt = [
      '# Ship the guide',
      'Write the guide to `docs/guide.md`.',
      '## Done when',
      '- `docs/faq.md` exists',
      '## Deliverables',
      '1. **Guide** the main text',
      '2. **Index** listed in docs/index.md'
    ].join('\n')
    expect(requestDeliverables(prompt).map((item) => [item.source, item.target])).toEqual([
      ['request', 'docs/guide.md'],
      ['prep', 'docs/faq.md'],
      ['mission', 'docs/index.md']
    ])
  })
})

describe('buildDeliverableContract', () => {
  const base = {
    workspacePath: '/repo',
    style: 'posix' as const,
    home: '/home/me',
    caseInsensitive: false
  }

  it('merges a claim into the request item that names the same file', () => {
    const contract = buildDeliverableContract({
      ...base,
      requested: [{ target: 'docs/guide.md', kind: 'file', source: 'request', claim: 'named' }],
      reply: 'I created `/repo/docs/guide.md` and `docs/extra.md`.'
    })
    expect(contract).toEqual([
      {
        target: 'docs/guide.md',
        kind: 'file',
        source: 'request',
        claim: 'created',
        resolved: '/repo/docs/guide.md'
      },
      {
        target: 'docs/extra.md',
        kind: 'file',
        source: 'claim',
        claim: 'created',
        resolved: '/repo/docs/extra.md'
      }
    ])
  })

  it('merges case-insensitively only when asked', () => {
    const reply = 'Created `Docs/A.md` and `docs/a.md`.'
    expect(buildDeliverableContract({ ...base, requested: [], reply })).toHaveLength(2)
    expect(
      buildDeliverableContract({ ...base, caseInsensitive: true, requested: [], reply })
    ).toHaveLength(1)
  })

  it('leaves paths unresolved without a workspace and links always', () => {
    const contract = buildDeliverableContract({
      ...base,
      workspacePath: null,
      requested: [],
      reply: 'Created `a.md` and published https://console.example.com/a/abcdef123456.'
    })
    expect(contract.map((item) => item.resolved)).toEqual([null, null])
  })
})
