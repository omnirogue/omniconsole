import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { consoleHandoffClient as client } from './console-handoff-client'
import { downloadHandoffFile } from './console-handoff-files'

const identity = vi.hoisted(() => ({ bearer: 'fixture-sender' }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: {
      bearer: identity.bearer,
      baseUrl: process.env.COLLABORATION_BRIDGE_URL,
      principal: identity.bearer,
      isCurrent: () => true
    }
  }),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

it.skipIf(!process.env.COLLABORATION_BRIDGE_URL)(
  'sends, replays, downloads and reviews the exact version through a hub on another host',
  async () => {
    const base = process.env.COLLABORATION_BRIDGE_URL!
    const fixture = (await (
      await fetch(`${base}/fixture`, { headers: { Authorization: 'Bearer fixture-sender' } })
    ).json()) as {
      taskId: string
      sha256: string
      path: string
      text: string
      sourceHost: string
      agentThreadId: string | null
    }
    expect(fixture.sourceHost).not.toBe(hostname())
    const input = {
      taskId: fixture.taskId,
      recipient: 'emp_uma',
      title: 'Cross-host desktop review',
      note: 'Review the exact attached version.',
      action: 'review' as const,
      fileVersions: [{ path: fixture.path, sha256: fixture.sha256 }],
      operationId: 'desktop-cross-host-0914'
    }
    const first = await client.send(input)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      throw new Error(JSON.stringify(first.error))
    }
    const threadId = first.data.thread_id!
    const replay = await client.send(input)
    expect(replay).toMatchObject({ ok: true, data: { thread_id: threadId } })
    identity.bearer = 'fixture-recipient'
    const queue = await client.list({ state: 'open' })
    expect(queue).toMatchObject({ ok: true })
    if (!queue.ok) {
      throw new Error(JSON.stringify(queue.error))
    }
    expect(queue.data.threads.filter((row) => row.id === threadId)).toHaveLength(1)
    expect(fixture.agentThreadId).toBeTruthy()
    expect(queue.data.threads.map((row) => row.id)).toEqual(
      expect.arrayContaining([threadId, fixture.agentThreadId])
    )
    const agentDetail = await client.get({ threadId: fixture.agentThreadId! })
    if (!agentDetail.ok) {
      throw new Error(JSON.stringify(agentDetail.error))
    }
    expect(agentDetail.data.files[0]?.sha256).toBe(fixture.sha256)
    const detail = await client.get({ threadId })
    if (!detail.ok) {
      throw new Error(JSON.stringify(detail.error))
    }
    const file = detail.data.files[0]!
    expect(file.sha256).toBe(fixture.sha256)
    const downloaded = await downloadHandoffFile({ threadId, file })
    if (!downloaded.ok) {
      throw new Error(JSON.stringify(downloaded.error))
    }
    const directory = await mkdtemp(join(tmpdir(), 'collaboration-recipient-'))
    try {
      const destination = join(directory, downloaded.data.name)
      await writeFile(destination, Buffer.from(downloaded.data.contentBase64, 'base64'), {
        flag: 'wx'
      })
      expect(await readFile(destination, 'utf8')).toBe(fixture.text)
      const reviewed = await client.review({
        threadId,
        decision: 'approve',
        versionIds: [file.id],
        note: 'Verified recipient bytes.',
        operationId: 'desktop-review-cross-host-0914'
      })
      expect(reviewed.ok).toBe(true)
      const after = await client.get({ threadId })
      if (!after.ok) {
        throw new Error(JSON.stringify(after.error))
      }
      expect(
        after.data.reviews.some(
          (review) => review.version_ids.includes(file.id) && review.decision === 'approve'
        )
      ).toBe(true)
      identity.bearer = 'fixture-outsider'
      expect((await downloadHandoffFile({ threadId, file })).ok).toBe(false)
      console.info(
        'CROSS_HOST_RECEIPT',
        JSON.stringify({
          threadId,
          agentThreadId: fixture.agentThreadId,
          fileId: file.id,
          sha256: file.sha256,
          sourceHost: fixture.sourceHost,
          recipientHost: hostname()
        })
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
      await fetch(`${base}/finish`, {
        method: 'POST',
        headers: { Authorization: 'Bearer fixture-recipient' }
      })
    }
  },
  60_000
)
