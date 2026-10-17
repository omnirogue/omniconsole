import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeArtifactLifecycle,
  fetchArtifactReviewStatus,
  resolveArtifactReviewSlug
} from './artifact-review-status'
import { type ArtifactShareScope, saveArtifactShareRecord } from './artifact-share-record-store'

const createdPaths: string[] = []
const apiUrl = 'http://localhost:3000'
const scope: ArtifactShareScope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: apiUrl
}

async function userDataPathWithRecord(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'omni-artifact-review-'))
  createdPaths.push(path)
  saveArtifactShareRecord('local-profile', path, '/repo/plan.html', {
    ...scope,
    slug: 'artifact-plan',
    editToken: 'edit-secret',
    shareUrl: `https://console.example.com/a/artifact-plan`
  })
  return path
}

function auth() {
  return { profileId: 'local-profile', scope, assertCurrent: vi.fn() }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('resolveArtifactReviewSlug', () => {
  it('uses the share record for the local file', async () => {
    const path = await userDataPathWithRecord()
    expect(
      resolveArtifactReviewSlug(path, auth(), { sourceKey: '/repo/plan.html', slug: 'ignored' })
    ).toBe('artifact-plan')
  })

  it('falls back to a raw slug when no record matches', async () => {
    const path = await userDataPathWithRecord()
    expect(resolveArtifactReviewSlug(path, auth(), { sourceKey: '/repo/abc', slug: 'abc' })).toBe(
      'abc'
    )
  })

  it('does not reuse a record from another cloud identity', async () => {
    const path = await userDataPathWithRecord()
    expect(() =>
      resolveArtifactReviewSlug(
        path,
        { ...auth(), scope: { ...scope, cloudUserId: 'user-b' } },
        { sourceKey: '/repo/plan.html' }
      )
    ).toThrow(/has not been shared from the active OmniConsole profile/)
  })
})

describe('fetchArtifactReviewStatus', () => {
  it('reads the review endpoint with the desktop credential', async () => {
    const path = await userDataPathWithRecord()
    const body = { status: 'approved', latest: null, decisions: [] }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const context = auth()

    await expect(
      fetchArtifactReviewStatus(path, { sourceKey: '/repo/plan.html' }, 'token-a', apiUrl, context)
    ).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiUrl}/v1/artifacts/artifact-plan/review`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer token-a' })
      })
    )
    expect(context.assertCurrent).toHaveBeenCalledTimes(2)
  })

  it('explains a missing artifact', async () => {
    const path = await userDataPathWithRecord()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'artifact_not_found' }), { status: 404 })
        )
    )
    await expect(
      fetchArtifactReviewStatus(path, { slug: 'gone' }, 'token-a', apiUrl, auth())
    ).rejects.toThrow('Artifact gone was not found for the signed-in OmniConsole account.')
  })
})

describe('changeArtifactLifecycle', () => {
  function respond(status: number, body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts the fenced body to the lifecycle route and returns the status document', async () => {
    const document = { status: 'approved', artifact: { slug: 'plan-1', lifecycle: 'done' } }
    const fetchMock = respond(200, document)
    const context = auth()
    const body = {
      action: 'close' as const,
      revision: 3,
      lifecycle: 'done' as const,
      ref: 'https://github.com/o/r/pull/9'
    }

    await expect(
      changeArtifactLifecycle('plan-1', body, 'token-a', apiUrl, context)
    ).resolves.toEqual(document)
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiUrl}/v1/artifacts/plan-1/lifecycle`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          authorization: 'Bearer token-a',
          'content-type': 'application/json'
        })
      })
    )
    expect(context.assertCurrent).toHaveBeenCalledTimes(2)
  })

  it('names an older server that has no lifecycle route', async () => {
    respond(404, { detail: 'Not Found' })
    await expect(
      changeArtifactLifecycle(
        'plan-1',
        { action: 'reopen', revision: 1, closedAt: 't' },
        't',
        apiUrl,
        auth()
      )
    ).rejects.toThrow('This OmniConsole server cannot change lifecycle yet.')
  })

  it('tells a missing page apart from a missing route', async () => {
    respond(404, { code: 'not_found' })
    await expect(
      changeArtifactLifecycle(
        'gone',
        { action: 'reopen', revision: 1, closedAt: 't' },
        't',
        apiUrl,
        auth()
      )
    ).rejects.toThrow('Artifact gone was not found for the signed-in OmniConsole account.')
  })

  it('explains a conflict in words and keeps its code', async () => {
    respond(409, { code: 'stale_revision' })
    await expect(
      changeArtifactLifecycle(
        'plan-1',
        { action: 'close', revision: 1, lifecycle: 'no_action' },
        't',
        apiUrl,
        auth()
      )
    ).rejects.toThrow(/newer revision.*\(stale_revision\)/)
  })
})
