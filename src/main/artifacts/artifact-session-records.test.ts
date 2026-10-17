import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ArtifactShareScope,
  getArtifactShareRecord,
  refreshArtifactShareRecordExpiration,
  saveArtifactShareRecord
} from './artifact-share-record-store'
import { listArtifactSessionRecordsForScope } from './artifact-session-records'

const createdPaths: string[] = []
const scope: ArtifactShareScope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://console.example.com'
}
const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'

async function userDataPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'omni-artifact-session-'))
  createdPaths.push(path)
  return path
}

function save(path: string, sourceKey: string, slug: string, extra: object = {}): void {
  saveArtifactShareRecord('local-profile', path, sourceKey, {
    ...scope,
    slug,
    editToken: `edit-secret-${slug}`,
    shareUrl: `https://console.example.com/a/${slug}`,
    ...extra
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('listArtifactSessionRecordsForScope', () => {
  it('never carries an edit token to the renderer', async () => {
    const path = await userDataPath()
    save(path, '/repo/plan.html', 'plan', { origin: { paneKey: PANE, worktreeId: 'wt-1' } })

    const records = listArtifactSessionRecordsForScope('local-profile', path, scope)

    expect(records).toEqual([
      {
        slug: 'plan',
        shareUrl: 'https://console.example.com/a/plan',
        sourceKey: '/repo/plan.html',
        savedAt: expect.any(Number),
        contentUrl: 'https://console.example.com/a/plan/content',
        origin: { paneKey: PANE, worktreeId: 'wt-1' }
      }
    ])
    expect(JSON.stringify(records)).not.toContain('edit-secret')
  })

  it('keeps records written before sessions were tracked, newest first', async () => {
    vi.useFakeTimers()
    const path = await userDataPath()
    vi.setSystemTime(1_000)
    save(path, '/repo/old.html', 'old')
    vi.setSystemTime(2_000)
    save(path, '/repo/new.html', 'new', { origin: { worktreeId: 'wt-1' } })

    const records = listArtifactSessionRecordsForScope('local-profile', path, scope)

    expect(records.map((record) => [record.slug, record.origin])).toEqual([
      ['new', { worktreeId: 'wt-1' }],
      ['old', null]
    ])
  })

  it('lists only records the signed-in scope owns', async () => {
    const path = await userDataPath()
    save(path, '/repo/mine.html', 'mine')
    save(path, '/repo/theirs.html', 'theirs', { cloudUserId: 'user-b' })

    expect(
      listArtifactSessionRecordsForScope('local-profile', path, scope).map((r) => r.slug)
    ).toEqual(['mine'])
  })

  it('moves ownership to the latest publishing session and keeps it on an origin-less update', async () => {
    const path = await userDataPath()
    save(path, '/repo/plan.html', 'plan', { origin: { worktreeId: 'wt-1' } })
    const expected = { slug: 'plan', editToken: 'edit-secret-plan' }
    const expiresAt = new Date(Date.now() + 60_000).toISOString()

    refreshArtifactShareRecordExpiration(
      'local-profile',
      path,
      '/repo/plan.html',
      scope,
      expected,
      expiresAt,
      {
        paneKey: PANE
      }
    )
    expect(getArtifactShareRecord('local-profile', path, '/repo/plan.html', scope)?.origin).toEqual(
      {
        paneKey: PANE
      }
    )

    refreshArtifactShareRecordExpiration(
      'local-profile',
      path,
      '/repo/plan.html',
      scope,
      expected,
      expiresAt
    )
    expect(getArtifactShareRecord('local-profile', path, '/repo/plan.html', scope)?.origin).toEqual(
      {
        paneKey: PANE
      }
    )
  })
})
