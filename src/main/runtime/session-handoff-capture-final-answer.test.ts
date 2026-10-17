import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import type { SessionFollowUpTranscriptSource } from '../../shared/session-follow-up-transcript'
import { readCompleteSessionTranscript } from '../transcripts/complete-session-transcript-reader'
import { captureSessionHandoff } from './session-handoff-capture'
import { installSessionHandoffSource } from './session-handoff-source'
import { prepareHandoffRoutes } from '../backoffice/handoff-route-prepare'
import { handoffRoutePreparationRequest } from '../../shared/handoff-route-preparation'

vi.mock('../backoffice/handoff-route-prepare', () => ({ prepareHandoffRoutes: vi.fn() }))

vi.mock('../transcripts/complete-session-transcript-reader', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readCompleteSessionTranscript: vi.fn()
}))

const TITLE = '💬 → 👥 review ×2 ↩'
const source: SessionFollowUpTranscriptSource = {
  kind: 'provider',
  hostId: 'local',
  agent: 'claude',
  sessionId: 'session-1234'
}
const roots: string[] = []
afterEach(async () => {
  installSessionHandoffSource(() => undefined)
  vi.mocked(prepareHandoffRoutes).mockReset()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function said(role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return {
    id: `${role}-${text}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

let captured: SessionFollowUpRule
async function capture(
  answerSource?: SessionFollowUpTranscriptSource,
  asked: Partial<SessionFollowUpRule> = {}
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'handoff-answer-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'ads.md'), '# Ads')
  const rule: SessionFollowUpRule = {
    revision: 1,
    taskId: null,
    taskTitle: TITLE,
    sessionLabel: TITLE,
    recipients: [
      {
        employeeId: 'emp_sal_qa_test',
        name: 'Sal Test Blake Test',
        operationId: 'handoff_answer_test',
        delivery: 'pending'
      }
    ],
    deliverables: { kind: 'files', paths: [] },
    destinationDirectory: workspace,
    includeSummary: true,
    note: TITLE,
    savedAt: 1,
    ...asked
  }
  // Why: a handoff-only plan states nothing but its title, which is all the person used to get.
  captured = await captureSessionHandoff(rule, workspace, TITLE, answerSource)
  return readFile(captured.files![0]!.sourcePath!, 'utf8')
}

it('gives a handoff-only plan’s summary the conversation’s final answer', async () => {
  vi.mocked(readCompleteSessionTranscript).mockResolvedValue([
    said('user', 'Write ads for OmniRogue'),
    said('assistant', 'Three ad angles are drafted in ads.md; angle 2 tested best.'),
    said('tool', 'exit 0')
  ])
  const summary = await capture(source)
  expect(summary).toContain(TITLE)
  expect(summary).toContain('angle 2 tested best.')
  // The plan's note is only its notation, so the request is written from the conversation.
  expect(captured.request).toMatchObject({ title: 'Hand off: Write ads for OmniRogue' })
  expect(captured.request?.description).toContain('angle 2 tested best.')
  // The summary is named for a person, and the rule says which file it is.
  expect(captured.summaryFile).toMatch(
    /^Summary - Write ads for OmniRogue - \d{4}-\d\d-\d\d \d{6}\.md$/
  )
  expect(captured.files?.map((pin) => pin.name)).toEqual([captured.summaryFile])
  expect(vi.mocked(readCompleteSessionTranscript).mock.calls[0]![0]).toMatchObject({
    sessionId: 'session-1234',
    expectedConnectionId: null
  })
})

it('names the transcript for a person, beside the summary, and keeps that name on a later round', async () => {
  vi.mocked(readCompleteSessionTranscript).mockResolvedValue([
    said('user', 'Write ads for OmniRogue'),
    said('assistant', 'Three ad angles are drafted in ads.md; angle 2 tested best.')
  ])
  await capture(source, { transcriptSource: source })
  const transcript = captured.files?.find((pin) => pin.generatedKind === 'transcript')
  expect(transcript?.name).toBe(
    captured.summaryFile?.replace(/^Summary/, 'Conversation transcript')
  )
  expect(transcript?.name).toMatch(
    /^Conversation transcript - Write ads for OmniRogue - \d{4}-\d\d-\d\d \d{6}\.md$/
  )
  // A later round posts under the first round's names, so each lands as the next version.
  await capture(source, {
    transcriptSource: source,
    reask: true,
    summaryFile: 'Summary - Write ads for OmniRogue - 2026-09-18 090000.md'
  })
  expect(captured.files?.find((pin) => pin.generatedKind === 'transcript')?.name).toBe(
    'Conversation transcript - Write ads for OmniRogue - 2026-09-18 090000.md'
  )
})

it('stays what the plan stated when the history cannot be read or belongs to another host', async () => {
  vi.mocked(readCompleteSessionTranscript).mockRejectedValue(new Error('gone'))
  expect(await capture(source)).toBe(TITLE)
  expect(await capture({ ...source, hostId: 'ssh:other' })).toBe(TITLE)
  expect(await capture()).toBe(TITLE)
  expect(captured.request).toBeUndefined()
})

it('refuses to send a final answer that holds a secret, as a transcript is refused', async () => {
  vi.mocked(readCompleteSessionTranscript).mockResolvedValue([
    said(
      'assistant',
      'Use this:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
    )
  ])
  await expect(capture(source)).rejects.toThrow(/protected-data gate/)
})

it('sends the files the conversation wrote when no work file was named', async () => {
  vi.mocked(readCompleteSessionTranscript).mockResolvedValue([
    said('user', 'Write ads'),
    {
      id: 'writes',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Write', input: { file_path: 'ads.md' } },
        { type: 'tool-call', name: 'Write', input: { file_path: '../outside.md' } },
        { type: 'tool-call', name: 'Write', input: { file_path: 'deleted-later.md' } }
      ],
      timestamp: null,
      source: 'transcript'
    },
    said('assistant', 'Done, see ads.md')
  ])
  await capture(source)
  // Outside the workspace and no longer on disk are skipped, never refused: they were inferred.
  expect(captured.files?.map((pin) => pin.name)).toEqual(['ads.md', captured.summaryFile])
})

it('routes a whole-working-tree hand-over through the chain’s branch before returning', async () => {
  const resolve = vi.fn(() => ({ chainId: 'chain_answer', answerSource: source }))
  installSessionHandoffSource(resolve)
  vi.mocked(readCompleteSessionTranscript).mockResolvedValue([
    said('assistant', 'The final result is ready.')
  ])
  vi.mocked(prepareHandoffRoutes).mockImplementation(async (input) => {
    const request = handoffRoutePreparationRequest.parse(input)
    return {
      ok: true,
      data: {
        git: null,
        pins: request.pins,
        memoLines: ['Files: summary'],
        refused: [],
        manifest: []
      }
    }
  })
  // Why: ordinary files stay attachments; only a rule that asks for the working tree is routed.
  expect(await capture(undefined, { includeWorkingTree: true })).toContain(
    'The final result is ready.'
  )
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(prepareHandoffRoutes).toHaveBeenCalledWith(
    expect.objectContaining({
      branch: 'handoff/chain_answer',
      includeWorkingTree: true
    })
  )
  expect(captured.note).toContain('Files: summary')
  expect(captured.request?.description).toContain('Files: summary')
})

it('does not return a deliverable capture when routing refuses it', async () => {
  installSessionHandoffSource(() => ({ chainId: 'chain_refused' }))
  vi.mocked(prepareHandoffRoutes).mockResolvedValue({
    ok: true,
    data: {
      git: null,
      pins: [],
      memoLines: [],
      manifest: [],
      refused: [{ name: 'summary', reason: 'The route refused this package.' }]
    }
  })
  await expect(capture(undefined, { includeWorkingTree: true })).rejects.toMatchObject({
    code: 'file-too-large',
    detail: 'The route refused this package.'
  })
})

it('never routes an ordinary hand-over: its files stay attachments on the thread', async () => {
  installSessionHandoffSource(() => ({ chainId: 'chain_plain', answerSource: source }))
  vi.mocked(readCompleteSessionTranscript).mockResolvedValue([said('assistant', 'Done.')])
  await capture()
  expect(prepareHandoffRoutes).not.toHaveBeenCalled()
})
