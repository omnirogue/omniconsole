import { describe, expect, it, vi } from 'vitest'
import type { DeliveredFileReading } from '../runtime/delivered-file-read'
import { checkDeliverables, type DeliverableCheckContext } from './deliverable-checks'
import type { DeliverableContractItem } from './deliverable-contract'

const file = (
  target: string,
  extra: Partial<DeliverableContractItem> = {}
): DeliverableContractItem => ({
  target,
  kind: 'file',
  source: 'request',
  claim: 'named',
  resolved: `/repo/${target}`,
  ...extra
})

function ctx(
  files: Record<string, DeliveredFileReading>,
  extra: Partial<DeliverableCheckContext> = {}
): DeliverableCheckContext {
  return {
    connectionId: null,
    hostLabel: 'this computer',
    readLocalFile: async (path) => files[path] ?? { status: 'unreadable', code: 'ENOENT' },
    readLocalDirectory: async () => null,
    statRemote: null,
    requestStartedAt: 1_000,
    writtenPaths: new Set(),
    sharedUrls: new Set(),
    ...extra
  }
}

const found = (path: string, size = 10, mtimeMs = 2_000): DeliveredFileReading => ({
  status: 'file',
  path,
  hash: 'a'.repeat(64),
  size,
  mtimeMs
})

describe('checkDeliverables on this computer', () => {
  it('verifies a file and records its facts, never its contents', async () => {
    const { checks, overall } = await checkDeliverables(
      [file('a.md')],
      ctx({ '/repo/a.md': found('/repo/a.md') })
    )
    expect(overall).toBe('complete')
    expect(checks[0]).toMatchObject({
      verdict: 'verified',
      path: '/repo/a.md',
      size: 10,
      sha256: 'a'.repeat(64)
    })
  })

  it('calls an absent, empty or folder target missing', async () => {
    const { checks, overall } = await checkDeliverables(
      [file('gone.md'), file('empty.md'), file('dir.md')],
      ctx({
        '/repo/empty.md': found('/repo/empty.md', 0),
        '/repo/dir.md': {
          status: 'not-file',
          path: '/repo/dir.md',
          size: 0,
          mtimeMs: 0,
          isDirectory: true
        }
      })
    )
    expect(overall).toBe('incomplete')
    expect(checks.map((check) => [check.verdict, check.detail])).toEqual([
      ['missing', 'no file on this computer'],
      ['missing', 'the file is empty (0 bytes)'],
      ['missing', 'a folder, not a file']
    ])
  })

  it('needs a claimed write to be newer than the request, unless this session wrote it', async () => {
    const stale = found('/repo/a.md', 10, 500)
    const claimed = file('a.md', { source: 'claim', claim: 'updated' })
    expect(
      (await checkDeliverables([claimed], ctx({ '/repo/a.md': stale }))).checks[0]?.detail
    ).toBe('not changed since this request started')
    const written = ctx({ '/repo/a.md': stale }, { writtenPaths: new Set(['/repo/a.md']) })
    expect((await checkDeliverables([claimed], written)).checks[0]?.verdict).toBe('verified')
    // A request-named file that already existed is fine: nobody claimed to change it.
    expect(
      (await checkDeliverables([file('a.md')], ctx({ '/repo/a.md': stale }))).checks[0]?.verdict
    ).toBe('verified')
  })

  it('treats an unreadable file as unverifiable, not missing', async () => {
    const { checks, overall } = await checkDeliverables(
      [file('a.md')],
      ctx({ '/repo/a.md': { status: 'unreadable', code: 'EACCES' } })
    )
    expect(checks[0]?.verdict).toBe('unverifiable')
    expect(overall).toBe('unverifiable')
  })

  it('turns a declined missing item into declined', async () => {
    const { checks, overall } = await checkDeliverables(
      [file('a.md', { source: 'claim', claim: 'created', declined: "I couldn't write `a.md`." })],
      ctx({})
    )
    expect(checks[0]?.verdict).toBe('declined')
    expect(overall).toBe('complete')
  })

  it('checks folders, artifacts and links', async () => {
    const items: DeliverableContractItem[] = [
      {
        target: 'out/',
        kind: 'directory',
        source: 'claim',
        claim: 'created',
        resolved: '/repo/out'
      },
      {
        target: 'https://x/a/abcdef12',
        kind: 'artifact',
        source: 'claim',
        claim: 'published',
        resolved: null
      },
      {
        target: 'https://x/a/zzzzzz99',
        kind: 'artifact',
        source: 'claim',
        claim: 'published',
        resolved: null
      },
      {
        target: 'https://github.com/o/r/pull/1',
        kind: 'url',
        source: 'claim',
        claim: 'published',
        resolved: null
      }
    ]
    const { checks } = await checkDeliverables(
      items,
      ctx({}, { readLocalDirectory: async () => 3, sharedUrls: new Set(['https://x/a/abcdef12']) })
    )
    expect(checks.map((check) => check.verdict)).toEqual([
      'verified',
      'verified',
      'unverifiable',
      'unverifiable'
    ])
  })

  it('cannot check an unresolved path', async () => {
    const { checks } = await checkDeliverables([file('~/a.md', { resolved: null })], ctx({}))
    expect(checks[0]?.verdict).toBe('unverifiable')
  })
})

describe('checkDeliverables on an SSH host', () => {
  it('never reads the local disk for a remote path', async () => {
    const readLocalFile = vi.fn()
    const statRemote = vi.fn(async () => ({ size: 4, isDirectory: false, mtime: 2_000 }))
    const { checks } = await checkDeliverables(
      [file('a.md')],
      ctx({}, { connectionId: 'c1', hostLabel: 'the SSH host', readLocalFile, statRemote })
    )
    expect(readLocalFile).not.toHaveBeenCalled()
    expect(statRemote).toHaveBeenCalledWith('/repo/a.md')
    expect(checks[0]?.verdict).toBe('verified')
  })

  it('is unverifiable without a provider, missing on not-found, unverifiable on other errors', async () => {
    const none = await checkDeliverables(
      [file('a.md')],
      ctx({}, { connectionId: 'c1', hostLabel: 'the SSH host' })
    )
    expect(none.checks[0]).toMatchObject({
      verdict: 'unverifiable',
      detail: 'the SSH host is not connected'
    })
    const notFound = await checkDeliverables(
      [file('a.md')],
      ctx(
        {},
        {
          connectionId: 'c1',
          statRemote: async () => {
            throw Object.assign(new Error('x'), { code: 'ENOENT' })
          }
        }
      )
    )
    expect(notFound.checks[0]?.verdict).toBe('missing')
    const broken = await checkDeliverables(
      [file('a.md')],
      ctx(
        {},
        {
          connectionId: 'c1',
          statRemote: async () => {
            throw new Error('channel closed')
          }
        }
      )
    )
    expect(broken.checks[0]?.verdict).toBe('unverifiable')
  })
})
