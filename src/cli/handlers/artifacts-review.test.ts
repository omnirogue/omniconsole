import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import type { ArtifactListItem } from '../../shared/artifacts'
import { ARTIFACT_REVIEW_NEXT_STEP } from '../artifact-format'
import { ARTIFACT_HANDLERS } from './artifacts'

const item: ArtifactListItem = {
  artifact: {
    version: 1,
    slug: 'artifact-1',
    title: null,
    originalFileName: 'plan.html',
    sourceContentType: 'text/html',
    renderedContentType: 'text/html',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    expiresAt: '2026-10-23T00:00:00.000Z',
    byteSize: 12,
    deletedAt: null
  },
  shareUrl: 'https://console.example.com/a/artifact-1'
}

const reviewedItem: ArtifactListItem = {
  ...item,
  artifact: {
    ...item.artifact,
    audience: 'team',
    revision: 1,
    review: { question: '', reviewers: [], status: 'pending', statusAt: null }
  }
}

function ok<T>(value: T) {
  return { id: 'request-1', ok: true, result: { status: 'ok', value }, _meta: { runtimeId: 'r' } }
}

async function planFolder(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omni-artifact-review-cli-'))
  await writeFile(join(cwd, 'plan.html'), '<h1>Plan</h1>', 'utf8')
  return cwd
}

function writeCall(value: ArtifactListItem) {
  return vi
    .fn()
    .mockImplementation((method: string) =>
      Promise.resolve(
        method === 'settings.get'
          ? { id: 'p', ok: true, result: { settings: {} }, _meta: { runtimeId: 'r' } }
          : ok(value)
      )
    )
}

// Why: inside an IDE terminal these name the publishing session and ride along as `origin`
// (see artifacts-origin.test.ts); clear them so the params below are the plain-shell ones.
beforeEach(() => {
  for (const name of ['ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_WORKTREE_ID']) {
    vi.stubEnv(name, '')
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('artifact review CLI', () => {
  it('sends the same share params as before when no review flag is passed', async () => {
    const cwd = await planFolder()
    const call = writeCall(item)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts share']!({
      client: { call } as never,
      cwd,
      flags: new Map([['file', 'plan.html']]),
      json: false
    })

    expect(call).toHaveBeenCalledWith('artifacts.share', {
      sourceKey: join(cwd, 'plan.html'),
      content: '<h1>Plan</h1>',
      contentType: 'text/html',
      fileName: 'plan.html'
    })
    expect(log).toHaveBeenCalledWith(item.shareUrl)
  })

  it.each(['artifacts share', 'artifacts update'])(
    'threads review flags through `%s` and prints the next step',
    async (command) => {
      const cwd = await planFolder()
      const call = writeCall(reviewedItem)
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

      await ARTIFACT_HANDLERS[command]!({
        client: { call } as never,
        cwd,
        flags: new Map([
          ['file', 'plan.html'],
          ['question', 'Approve this launch?'],
          ['reviewers', 'a@example.com,emp_7'],
          ['audience', 'reviewers']
        ]),
        json: false
      })

      expect(call).toHaveBeenCalledWith(
        command.replace(' ', '.'),
        expect.objectContaining({
          review: { question: 'Approve this launch?', reviewers: ['a@example.com', 'emp_7'] },
          audience: 'reviewers'
        })
      )
      const printed = String(log.mock.calls.at(-1)?.[0])
      expect(printed).toContain('review: pending')
      expect(printed).toContain(ARTIFACT_REVIEW_NEXT_STEP)
    }
  )

  it('rejects an invalid audience before contacting the runtime', async () => {
    const cwd = await planFolder()
    const call = vi.fn()

    await expect(
      ARTIFACT_HANDLERS['artifacts share']!({
        client: { call } as never,
        cwd,
        flags: new Map([
          ['file', 'plan.html'],
          ['audience', 'world']
        ]),
        json: false
      })
    ).rejects.toThrow(/--audience must be one of/)
    expect(call).not.toHaveBeenCalled()
  })

  it('reads the status of a shared file and prints the decision', async () => {
    const status: ArtifactReviewStatus = {
      artifact: reviewedItem.artifact,
      shareUrl: reviewedItem.shareUrl,
      status: 'approved',
      latest: {
        id: 'd1',
        revision: 1,
        decision: 'approved',
        comment: 'Go',
        edits: null,
        by: { email: 'sal@example.com', name: 'Sal' },
        at: '2026-09-23T10:00:00.000Z'
      },
      decisions: [],
      viewer: { signedIn: true, isOwner: true, canDecide: false }
    }
    const call = vi.fn().mockResolvedValue(ok(status))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts status']!({
      client: { call } as never,
      cwd: '/repo',
      flags: new Map<string, string | boolean>([
        ['file', 'plan.html'],
        ['wait', '120']
      ]),
      json: false
    })

    // A decided review stops the wait after one read.
    expect(call).toHaveBeenCalledExactlyOnceWith('artifacts.reviewStatus', {
      sourceKey: resolve('/repo', 'plan.html')
    })
    const printed = String(log.mock.calls.at(-1)?.[0])
    expect(printed).toContain('status: approved')
    expect(printed).toContain('decision: approved by Sal <sal@example.com>')
    expect(printed).toContain('comment: Go')
  })

  it('closes a review by slug with its reason', async () => {
    const status = { status: 'withdrawn', latest: null, decisions: [], shareUrl: item.shareUrl }
    const call = vi.fn().mockResolvedValue(ok(status))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts close-review']!({
      client: { call } as never,
      cwd: '/repo',
      flags: new Map([
        ['file', 'artifact-1'],
        ['reason', 'Answered in the terminal']
      ]),
      json: true
    })

    expect(call).toHaveBeenCalledExactlyOnceWith('artifacts.closeReview', {
      sourceKey: resolve('/repo', 'artifact-1'),
      slug: 'artifact-1',
      reason: 'Answered in the terminal'
    })
  })

  it.each([
    { lifecycle: 'no_action' as const, closedAt: '2026-10-07T00:00:00Z' },
    { supersededBy: 'successor', supersededAt: '2026-10-07T00:00:00Z' }
  ])(
    'stops --wait immediately for final lifecycle with a pending review: %j',
    async (lifecycle) => {
      const status: ArtifactReviewStatus = {
        artifact: { ...reviewedItem.artifact, ...lifecycle },
        shareUrl: reviewedItem.shareUrl,
        status: 'pending',
        latest: null,
        decisions: [],
        viewer: { signedIn: true, isOwner: true, canDecide: false }
      }
      const call = vi.fn().mockResolvedValue(ok(status))
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      await ARTIFACT_HANDLERS['artifacts status']!({
        client: { call } as never,
        cwd: '/repo',
        flags: new Map([
          ['file', 'artifact-1'],
          ['wait', '600']
        ]),
        json: true
      })
      expect(call).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toEqual(status)
    }
  )

  it('stops --wait once a review has its responses in and says it is not an approval', async () => {
    const status: ArtifactReviewStatus = {
      artifact: {
        ...reviewedItem.artifact,
        review: { ...reviewedItem.artifact.review!, type: 'review', mode: 'collect' }
      },
      shareUrl: reviewedItem.shareUrl,
      status: 'pending',
      latest: null,
      decisions: [],
      viewer: { signedIn: true, isOwner: true, canDecide: false },
      progress: {
        id: 'artifact-1:1',
        revision: 1,
        submitted: 2,
        of: 3,
        setAside: 1,
        everyone: false,
        ready: true,
        readyAt: '2026-10-10T12:00:00Z',
        reason: 'all',
        overdue: false,
        people: []
      }
    }
    const call = vi.fn().mockResolvedValue(ok(status))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await ARTIFACT_HANDLERS['artifacts status']!({
      client: { call } as never,
      cwd: '/repo',
      flags: new Map([
        ['file', 'artifact-1'],
        ['wait', '600']
      ]),
      json: false
    })
    expect(call).toHaveBeenCalledTimes(1)
    const printed = String(log.mock.calls.at(-1)?.[0])
    expect(printed).toContain('status: responses_in')
    expect(printed).toContain(
      'responses: in, 2 of 3 answered, 1 set aside. This is not an approval'
    )
    expect(printed).toContain('in one comment on the page (OmniConsole artifact_comment')
    expect(printed).toContain(
      'If you were told to act on the answers and the ask is still open, act, then close it with the conclusion: omni artifacts close artifact-1 --done --revision 1 --note'
    )
    expect(printed).toContain("Otherwise the decision and the close are the owner's.")
  })

  it('accepts a raw slug and prints the raw result with --json', async () => {
    const status = { status: null, latest: null, decisions: [], shareUrl: item.shareUrl }
    const call = vi.fn().mockResolvedValue(ok(status))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await ARTIFACT_HANDLERS['artifacts status']!({
      client: { call } as never,
      cwd: '/repo',
      flags: new Map([['file', 'artifact-1']]),
      json: true
    })

    expect(call).toHaveBeenCalledWith('artifacts.reviewStatus', {
      sourceKey: resolve('/repo', 'artifact-1'),
      slug: 'artifact-1'
    })
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result).toEqual(status)
  })
})
