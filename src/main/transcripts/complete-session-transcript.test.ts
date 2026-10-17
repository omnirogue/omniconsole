import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../shared/agent-session-wire'
import type { NativeChatTranscriptPageResult } from '../../shared/native-chat-transcript-page'
import { buildCompleteSessionTranscript } from './complete-session-transcript'
import {
  readCompleteSessionTranscript,
  type CompleteTranscriptSource
} from './complete-session-transcript-reader'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function source(lines: string[]): Promise<CompleteTranscriptSource & { capturedAt: string }> {
  const root = await mkdtemp(join(tmpdir(), 'complete-history-'))
  roots.push(root)
  const transcriptPath = join(root, 'session.jsonl')
  await writeFile(transcriptPath, `${lines.join('\n')}\n`)
  return {
    kind: 'provider',
    agent: 'codex',
    sessionId: 'history-test',
    transcriptPath,
    expectedConnectionId: null,
    capturedAt: '2026-09-14T12:00:00.000Z'
  }
}
function line(message: string): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } })
}

it('captures more than the old 5000-message tail with no omitted earlier messages', async () => {
  const result = await buildCompleteSessionTranscript(
    await source(Array.from({ length: 5201 }, (_, index) => line(`Message ${index}.`)))
  )
  expect(result.kind).toBe('built')
  if (result.kind !== 'built') {
    throw new Error('Expected a complete document')
  }
  expect(result).toMatchObject({ earlierMessagesOmitted: false, omittedRecords: 0 })
  expect(result.deliverable.messageCount).toBe(5201)
  expect(result.deliverable.truncatedBlocks).toBe(0)
  expect(result.deliverable.bytes.toString()).toContain('Message 0.')
  expect(result.deliverable.bytes.toString()).toContain('Message 5200.')
  expect(result.deliverable.sha256).toBe(
    createHash('sha256').update(result.deliverable.bytes).digest('hex')
  )
})
it('refuses a protected value in early history instead of shipping a clean-looking tail', async () => {
  const key = `sk-ant-${'a'.repeat(50)}`
  const result = await buildCompleteSessionTranscript(
    await source([
      line(key),
      ...Array.from({ length: 5001 }, (_, index) => line(`Message ${index}.`))
    ])
  )
  expect(result).toMatchObject({ kind: 'refused' })
  expect(JSON.stringify(result)).not.toContain(key)
})
it('refuses malformed source records without producing a partial file', async () => {
  expect(await buildCompleteSessionTranscript(await source([line('Readable'), '{broken']))).toEqual(
    { kind: 'error', code: 'transcript_incomplete' }
  )
})

function page(): Extract<NativeChatTranscriptPageResult, { messages: unknown }> {
  return {
    source: { connectionId: 'remote' },
    messages: [
      {
        id: 'm',
        role: 'user',
        blocks: [{ type: 'text', text: 'Remote history' }],
        timestamp: 1,
        source: 'transcript'
      }
    ],
    sourceRecords: [{ byteOffset: 0, text: '{}' }],
    coverage: {
      format: 'jsonl',
      projection: 'display',
      fromByteOffset: 0,
      toByteOffset: 3,
      snapshotBytes: 3,
      rawRecords: 'complete'
    },
    complete: true,
    malformedRecordCount: 0,
    oversizedRecordCount: 0,
    truncatedRecordCount: 0
  }
}
const remote: CompleteTranscriptSource = {
  kind: 'provider',
  agent: 'codex',
  sessionId: 'remote-session',
  expectedConnectionId: 'remote'
}
it('pins SSH ownership and refuses local or incomplete/raw-only responses', async () => {
  const provider = vi.fn().mockResolvedValue(page())
  const readers = {
    provider,
    structured: () => {
      throw new Error('Not structured')
    }
  }
  expect(await readCompleteSessionTranscript(remote, undefined, readers)).toHaveLength(1)
  expect(provider).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: 'remote', sessionId: 'remote-session' }),
    undefined
  )
  provider.mockResolvedValue({ ...page(), source: { connectionId: null } })
  await expect(readCompleteSessionTranscript(remote, undefined, readers)).rejects.toThrow()
  provider.mockResolvedValue({
    ...page(),
    coverage: { ...page().coverage, projection: 'raw-only' }
  })
  await expect(readCompleteSessionTranscript(remote, undefined, readers)).rejects.toThrow()
  provider.mockResolvedValue({ ...page(), truncatedRecordCount: 1 })
  await expect(readCompleteSessionTranscript(remote, undefined, readers)).rejects.toThrow()
})
it('refuses an oversized snapshot or a missing continuation cursor before repeated reads', async () => {
  const provider = vi.fn().mockResolvedValue({
    ...page(),
    coverage: {
      ...page().coverage,
      snapshotBytes: 40 * 1024 * 1024,
      toByteOffset: 40 * 1024 * 1024
    }
  })
  const readers = {
    provider,
    structured: () => {
      throw new Error('Not structured')
    }
  }
  await expect(readCompleteSessionTranscript(remote, undefined, readers)).rejects.toThrow()
  provider.mockResolvedValue({ ...page(), complete: false })
  await expect(readCompleteSessionTranscript(remote, undefined, readers)).rejects.toThrow()
  expect(provider).toHaveBeenCalledTimes(2)
})

it('reads all structured pages under the same session epoch and runtime fence', async () => {
  const structured = vi.fn((args: AgentSessionHistoryRequest): AgentSessionHistoryResult => {
    const sequence = args.cursor ? 1 : 2
    return {
      ok: true,
      page: {
        sessionId: 'structured-session',
        epoch: 'epoch',
        fence: 5,
        direction: args.direction,
        items: [
          {
            itemId: `item-${sequence}`,
            revision: 1,
            sequence,
            observedAt: 1,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: `Structured ${sequence}` }]
            }
          }
        ],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'epoch', sequence },
          newest: { epoch: 'epoch', sequence },
          nextCursor: { epoch: 'epoch', sequence }
        },
        hasOlder: !args.cursor,
        hasNewer: false
      }
    }
  })
  const result = await readCompleteSessionTranscript(
    { ...remote, kind: 'structured', sessionId: 'structured-session', expectedConnectionId: null },
    undefined,
    { provider: vi.fn(), structured }
  )
  expect(result.map((message) => message.blocks)).toEqual([
    [{ type: 'text', text: 'Structured 1' }],
    [{ type: 'text', text: 'Structured 2' }]
  ])
  expect(structured).toHaveBeenCalledTimes(2)
})
