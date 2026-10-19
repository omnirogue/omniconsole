import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { COMMAND_SPECS } from '../specs'
import { ARTIFACT_HANDLERS } from './artifacts'
import { ARTIFACT_LIFECYCLE_HANDLERS, artifactSlugFromReference } from './artifact-lifecycle'

// Why both: dispatch loads the lifecycle commands and `artifacts status` from separate groups.
const HANDLERS = { ...ARTIFACT_HANDLERS, ...ARTIFACT_LIFECYCLE_HANDLERS }

function status(fields: Record<string, unknown> = {}): ArtifactReviewStatus {
  return {
    artifact: {
      version: 1,
      slug: 'plan-1',
      title: null,
      originalFileName: 'plan.html',
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
      expiresAt: '2026-10-30T00:00:00.000Z',
      byteSize: 12,
      deletedAt: null,
      revision: 3,
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null,
      ...fields
    },
    shareUrl: 'https://console.example.com/a/plan-1',
    status: 'approved',
    latest: null,
    decisions: [],
    viewer: { signedIn: true, isOwner: true, canDecide: false }
  }
}

function ok<T>(value: T) {
  return { id: 'request-1', ok: true, result: { status: 'ok', value }, _meta: { runtimeId: 'r' } }
}

/** First call answers the status read, second the lifecycle post. */
function client(current: ArtifactReviewStatus, after: ArtifactReviewStatus) {
  return vi.fn().mockResolvedValueOnce(ok(current)).mockResolvedValueOnce(ok(after))
}

async function run(
  command: string,
  flags: [string, string | boolean][],
  call: ReturnType<typeof vi.fn>,
  json = true
): Promise<void> {
  await HANDLERS[command]!({
    client: { call } as never,
    cwd: '/repo',
    flags: new Map(flags),
    json
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('artifact lifecycle CLI spec', () => {
  it.each([
    ['artifacts', 'close', 'plan.html', '--done', '--ref', 'https://x.test/pr/1', '--json'],
    ['artifacts', 'close', '--no-action', 'plan.html', '--note', 'Answered'],
    ['artifacts', 'close', '--expect-open', 'plan.html', '--no-action', '--revision', '3'],
    ['artifacts', 'supersede', 'plan.html', '--by', 'plan-2'],
    [
      'artifacts',
      'supersede',
      '--expect-unsuperseded',
      'plan.html',
      '--by',
      'plan-2',
      '--revision',
      '3'
    ],
    ['artifacts', 'reopen', 'plan.html'],
    ['artifacts', 'unsupersede', 'plan.html', '--json']
  ])('parses %j with the file as a positional', (...argv) => {
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    expect(parsed.flags.get('file')).toBe('plan.html')
  })
})

describe('artifact lifecycle CLI', () => {
  it('supersedes only the audited revision with the existing unsuperseded predicate', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = client(status({ revision: 4 }), status({ supersededBy: 'plan-2' }))
    await run(
      'artifacts supersede',
      [
        ['file', 'plan-1'],
        ['by', 'plan-2'],
        ['revision', '3'],
        ['expect-unsuperseded', true]
      ],
      call
    )
    expect(call).toHaveBeenNthCalledWith(2, 'artifacts.lifecycle', {
      id: 'plan-1',
      body: { action: 'supersede', revision: 3, by: 'plan-2', expect: 'unsuperseded' }
    })
  })

  it('keeps the human-answered revision even when the status read sees newer work', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = client(status({ revision: 4 }), status({ lifecycle: 'no_action' }))
    await run(
      'artifacts close',
      [
        ['file', 'plan-1'],
        ['no-action', true],
        ['revision', '3'],
        ['expect-open', true],
        ['note', 'Answered in session source-ref: human said set aside']
      ],
      call
    )
    expect(call).toHaveBeenNthCalledWith(2, 'artifacts.lifecycle', {
      id: 'plan-1',
      body: {
        action: 'close',
        revision: 3,
        lifecycle: 'no_action',
        expect: 'open',
        note: 'Answered in session source-ref: human said set aside'
      }
    })
  })

  it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992', ''])(
    'rejects invalid expected revision %j before reading',
    async (revision) => {
      const call = vi.fn()
      await expect(
        run(
          'artifacts close',
          [
            ['file', 'plan-1'],
            ['no-action', true],
            ['revision', revision]
          ],
          call
        )
      ).rejects.toThrow('--revision must be a positive integer')
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('reads the revision, then closes as done with its result link', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = client(status(), status({ lifecycle: 'done', closedAt: 't1' }))

    await run(
      'artifacts close',
      [
        ['file', 'plan.html'],
        ['done', true],
        ['ref', 'https://github.com/o/r/pull/9'],
        ['note', 'Shipped']
      ],
      call
    )

    expect(call).toHaveBeenNthCalledWith(1, 'artifacts.reviewStatus', {
      sourceKey: resolve('/repo', 'plan.html')
    })
    expect(call).toHaveBeenNthCalledWith(2, 'artifacts.lifecycle', {
      id: 'plan-1',
      body: {
        action: 'close',
        revision: 3,
        lifecycle: 'done',
        note: 'Shipped',
        ref: 'https://github.com/o/r/pull/9'
      }
    })
  })

  it('closes by page id as no action and prints the closure in words', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = client(
      status(),
      status({ lifecycle: 'no_action', closedAt: '2026-09-30T10:00:00Z' })
    )

    await run(
      'artifacts close',
      [
        ['file', 'plan-1'],
        ['no-action', true]
      ],
      call,
      false
    )

    expect(call.mock.calls[0]).toEqual([
      'artifacts.reviewStatus',
      { sourceKey: resolve('/repo', 'plan-1'), slug: 'plan-1' }
    ])
    expect(call.mock.calls[1][1]).toMatchObject({
      body: { action: 'close', revision: 3, lifecycle: 'no_action' }
    })
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(
      'closed: no action needed at 2026-09-30T10:00:00Z'
    )
  })

  it.each([
    [
      [
        ['no-action', true],
        ['done', true]
      ],
      /exactly one of --done or --no-action/
    ],
    [[], /exactly one of --done or --no-action/],
    [
      [
        ['no-action', true],
        ['ref', 'https://x.test/a']
      ],
      /only with --done/
    ],
    [
      [
        ['done', true],
        ['ref', 'http://x.test/a']
      ],
      /https link/
    ],
    [
      [
        ['done', true],
        ['note', 'x'.repeat(501)]
      ],
      /at most 500/
    ]
  ] as [[string, string | boolean][], RegExp][])(
    'refuses bad close flags before contacting the runtime (%j)',
    async (flags, message) => {
      const call = vi.fn()
      await expect(run('artifacts close', [['file', 'plan.html'], ...flags], call)).rejects.toThrow(
        message
      )
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('supersedes with a successor given as a page link', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = client(status(), status({ supersededBy: 'plan-2', supersededAt: 't2' }))

    await run(
      'artifacts supersede',
      [
        ['file', 'plan.html'],
        ['by', 'https://console.example.com/a/plan-2']
      ],
      call
    )

    expect(call.mock.calls[1]).toEqual([
      'artifacts.lifecycle',
      { id: 'plan-1', body: { action: 'supersede', revision: 3, by: 'plan-2' } }
    ])
  })

  it('reopens with the closure token it just read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const closedAt = '2026-09-30T10:00:00.123456+00:00'
    const call = client(status({ lifecycle: 'done', closedAt }), status())

    await run('artifacts reopen', [['file', 'plan.html']], call)

    expect(call.mock.calls[1][1]).toEqual({
      id: 'plan-1',
      body: { action: 'reopen', revision: 3, closedAt }
    })
  })

  it('unsupersedes with the successor and token it just read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const call = client(status({ supersededBy: 'plan-2', supersededAt: 't2' }), status())

    await run('artifacts unsupersede', [['file', 'plan.html']], call)

    expect(call.mock.calls[1][1]).toEqual({
      id: 'plan-1',
      body: { action: 'unsupersede', revision: 3, by: 'plan-2', supersededAt: 't2' }
    })
  })

  it('does not post a reopen for a page that is not closed', async () => {
    const call = vi.fn().mockResolvedValueOnce(ok(status()))
    await expect(run('artifacts reopen', [['file', 'plan.html']], call)).rejects.toThrow(
      'Artifact plan-1 is not closed.'
    )
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('refuses a server that reports no revision', async () => {
    const current = status()
    delete (current.artifact as { revision?: number }).revision
    const call = vi.fn().mockResolvedValueOnce(ok(current))
    await expect(
      run(
        'artifacts close',
        [
          ['file', 'plan.html'],
          ['no-action', true]
        ],
        call
      )
    ).rejects.toThrow(/cannot change lifecycle yet/)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('sends the SSH file identity from the relay', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubEnv(
      'ORCA_REMOTE_ARTIFACT_INPUT',
      JSON.stringify({ sourceKey: '/remote/plan.html', fileName: 'plan.html' })
    )
    const call = client(status({ lifecycle: 'no_action', closedAt: 't1' }), status())

    await run('artifacts reopen', [['file', 'plan.html']], call)

    expect(call.mock.calls[0][1]).toEqual({ sourceKey: '/remote/plan.html' })
  })
})

describe('artifact lifecycle CLI over an older SSH relay (no file identity)', () => {
  it('refuses the file form without reading or changing any page', async () => {
    vi.stubEnv('ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND', 'ssh')
    vi.stubEnv('ORCA_REMOTE_ARTIFACT_INPUT', '')
    const call = vi.fn()

    await expect(
      run(
        'artifacts close',
        [
          ['file', 'plan.html'],
          ['no-action', true]
        ],
        call
      )
    ).rejects.toThrow(/Pass the page id or link instead/)
    expect(call).not.toHaveBeenCalled()
  })

  it('accepts the page id form and sends only the id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubEnv('ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND', 'ssh')
    vi.stubEnv('ORCA_REMOTE_ARTIFACT_INPUT', '')
    const call = client(status(), status({ lifecycle: 'no_action', closedAt: 't1' }))

    await run(
      'artifacts close',
      [
        ['file', 'plan-1'],
        ['no-action', true]
      ],
      call
    )

    expect(call.mock.calls[0]).toEqual(['artifacts.reviewStatus', { slug: 'plan-1' }])
    expect(call.mock.calls[1][1]).toMatchObject({ id: 'plan-1' })
  })
})

describe('artifact status --wait on a closed page', () => {
  it.each([
    [{ lifecycle: 'no_action', closedAt: 't1' }],
    [{ supersededBy: 'plan-2', supersededAt: 't2' }]
  ])('ends after the first read while the review still reads pending (%j)', async (fields) => {
    const pendingButClosed = { ...status(fields), status: 'pending' }
    const call = vi.fn().mockResolvedValue(ok(pendingButClosed))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await run(
      'artifacts status',
      [
        ['file', 'plan-1'],
        ['wait', '1']
      ],
      call
    )

    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('artifactSlugFromReference', () => {
  it('takes a page id or the id from an https page link', () => {
    expect(artifactSlugFromReference('plan-2')).toBe('plan-2')
    expect(artifactSlugFromReference('https://console.example.com/a/plan-2')).toBe('plan-2')
    expect(artifactSlugFromReference('https://console.example.com/a/plan-2/?x=1')).toBe('plan-2')
    expect(() => artifactSlugFromReference('http://console.example.com/a/plan-2')).toThrow(
      /--by takes/
    )
    expect(() => artifactSlugFromReference('../admin')).toThrow(/--by takes/)
  })
})
