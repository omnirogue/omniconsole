import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexTranscriptPollDelay,
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import { readJsonlCursor, type JsonlCursor } from './codex-subagent-transcript-io'
import type { CodexSubagentRoster } from './codex-subagent-roster'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-budget-'))
  dirs.push(dir)
  return dir
}
function line(value: unknown) {
  return `${JSON.stringify(value)}\n`
}
function activity(id: string) {
  return line({
    type: 'event_msg',
    payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: id, occurred_at_ms: 1 }
  })
}

describe('Codex transcript I/O bounds', () => {
  it('discovers live children before and after a large backlog without skipping history', async () => {
    const path = join(directory(), 'parent.jsonl')
    writeFileSync(
      path,
      activity('historical-child') +
        Array.from({ length: 20 }, () => line({ text: 'x'.repeat(200_000) })).join('') +
        activity('current-child')
    )
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    for (let poll = 0; poll < 20; poll++) {
      await reconcileCodexSubagentTranscript(state, roster, path)
    }
    expect(roster.has('historical-child')).toBe(true)
    expect(roster.has('current-child')).toBe(true)
    expect(state.parent.remainingBytes).toBe(0)
  })
  it('discards roster mutations when the owner generation changes during a read', async () => {
    const path = join(directory(), 'parent.jsonl')
    writeFileSync(path, activity('obsolete-child'))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    let current = true
    const pending = reconcileCodexSubagentTranscript(state, roster, path, () => current)
    current = false
    await pending
    expect(roster.size).toBe(0)
    expect(state.subagents.size).toBe(0)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)
    expect(codexTranscriptPollDelay(state)).toBeUndefined()
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('obsolete-child')).toBe(true)
  })
  it('replays a completion rejected after its child read', async () => {
    const dir = directory()
    const path = join(dir, 'parent.jsonl')
    const childPath = join(dir, 'rollout-child.jsonl')
    writeFileSync(path, activity('child'))
    writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    await reconcileCodexSubagentTranscript(state, roster, path)
    const child = state.subagents.get('child')!
    const previousOffset = child.offset
    writeFileSync(
      childPath,
      line({ type: 'event_msg', payload: { type: 'task_started' } }) +
        line({ type: 'event_msg', payload: { type: 'task_complete' } })
    )
    await reconcileCodexSubagentTranscript(
      state,
      roster,
      path,
      () => child.offset === previousOffset
    )
    expect(roster.has('child')).toBe(true)
    expect(child.pendingRecords).toHaveLength(1)
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('child')).toBe(false)
    expect(state.subagents.size).toBe(0)
  })
  it('retains a pending parent scan until a lifecycle record beyond the first budget is reached', async () => {
    const path = join(directory(), 'parent.jsonl')
    writeFileSync(path, line({ text: 'x'.repeat(300_000) }) + activity('child'))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.size).toBe(0)
    expect(state.parent.offset).toBeLessThanOrEqual(256 * 1024)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)
    expect(codexTranscriptPollDelay(state)).toBe(10)
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('child')).toBe(true)
    expect(state.parent.carry.length).toBe(0)
  })
  it('caps retained children and makes fair progress through large child transcripts', async () => {
    const dir = directory()
    const path = join(dir, 'parent.jsonl')
    writeFileSync(
      path,
      Array.from({ length: 50 }, (_, index) => activity(`child-${index}`)).join('')
    )
    for (let index = 0; index < 50; index++) {
      writeFileSync(
        join(dir, `rollout-child-${index}.jsonl`),
        line({ text: 'x'.repeat(600_000) }) +
          line({ type: 'event_msg', payload: { type: 'task_complete' } })
      )
    }
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(state.subagents.size).toBe(32)
    expect(state.parent.pendingRecords).toHaveLength(18)
    expect(
      [...state.subagents.values()].reduce((total, child) => total + child.offset, 0)
    ).toBeLessThanOrEqual(1024 * 1024)
    for (let index = 0; index < 40 && hasTrackedCodexTranscriptSubagents(state); index++) {
      await reconcileCodexSubagentTranscript(state, roster, path)
      expect(state.subagents.size).toBeLessThanOrEqual(32)
    }
    expect(roster.size).toBe(0)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
  })
  it('does not lose a live child behind completed children filling the tracking cap', async () => {
    const dir = directory()
    const path = join(dir, 'parent.jsonl')
    writeFileSync(path, Array.from({ length: 33 }, (_, i) => activity(`child-${i}`)).join(''))
    for (let i = 0; i < 32; i++) {
      writeFileSync(
        join(dir, `rollout-child-${i}.jsonl`),
        line({ text: 'x'.repeat(600_000) }) +
          line({ type: 'event_msg', payload: { type: 'task_complete' } })
      )
    }
    writeFileSync(
      join(dir, 'rollout-child-32.jsonl'),
      line({ type: 'event_msg', payload: { type: 'task_started' } })
    )
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    for (let poll = 0; poll < 40 && !roster.has('child-32'); poll++) {
      await reconcileCodexSubagentTranscript(state, roster, path)
      expect(state.subagents.size).toBeLessThanOrEqual(32)
    }
    expect(roster.has('child-32')).toBe(true)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)
  })
  it('applies interrupts even when discovery capacity is full', async () => {
    const dir = directory()
    const path = join(dir, 'parent.jsonl')
    const interrupt = (id: string) =>
      line({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'interrupted',
          agent_thread_id: id,
          occurred_at_ms: 2
        }
      })
    writeFileSync(
      path,
      Array.from({ length: 34 }, (_, i) => activity(`child-${i}`)).join('') +
        interrupt('child-32') +
        interrupt('child-0')
    )
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('child-0')).toBe(false)
    expect(state.parent.pendingRecords).toHaveLength(1)
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('child-33')).toBe(true)
    expect(roster.has('child-32')).toBe(false)
    expect(state.subagents.size).toBe(32)
    expect(codexTranscriptPollDelay(state)).toBeUndefined()
  })
  it.each([false, true])(
    'reads interrupts beyond a full-capacity deferred start (appended=%s)',
    async (appended) => {
      const dir = directory()
      const path = join(dir, 'parent.jsonl')
      const starts = Array.from({ length: 33 }, (_, i) => activity(`child-${i}`)).join('')
      const interrupts = Array.from({ length: 33 }, (_, i) =>
        line({
          type: 'event_msg',
          payload: {
            type: 'sub_agent_activity',
            kind: 'interrupted',
            agent_thread_id: `child-${i}`,
            occurred_at_ms: 2
          }
        })
      ).join('')
      writeFileSync(
        path,
        starts + (appended ? '' : line({ text: 'x'.repeat(300_000) }) + interrupts)
      )
      for (let i = 0; i < 33; i++) {
        writeFileSync(
          join(dir, `rollout-child-${i}.jsonl`),
          line({ type: 'event_msg', payload: { type: 'task_started' } })
        )
      }
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()
      await reconcileCodexSubagentTranscript(state, roster, path)
      if (appended) {
        appendFileSync(path, interrupts)
      }
      for (let poll = 0; poll < 10 && hasTrackedCodexTranscriptSubagents(state); poll++) {
        await reconcileCodexSubagentTranscript(state, roster, path)
        expect(state.subagents.size).toBeLessThanOrEqual(32)
      }
      expect(roster.size).toBe(0)
      expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
      expect(state.parent.remainingBytes).toBe(0)
    }
  )
  it('backs off catch-up polling when the parent becomes unreadable', async () => {
    const path = join(directory(), 'parent.jsonl')
    writeFileSync(path, line({ text: 'x'.repeat(600_000) }))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(codexTranscriptPollDelay(state)).toBe(10)
    unlinkSync(path)
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(codexTranscriptPollDelay(state)).toBeUndefined()
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
  })
  it('checks for a child restart appended after a rejected completion', async () => {
    const dir = directory()
    const path = join(dir, 'parent.jsonl')
    const childPath = join(dir, 'rollout-child.jsonl')
    const started = line({ type: 'event_msg', payload: { type: 'task_started' } })
    writeFileSync(path, activity('child'))
    writeFileSync(childPath, started)
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    await reconcileCodexSubagentTranscript(state, roster, path)
    const child = state.subagents.get('child')!
    const previousOffset = child.offset
    appendFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
    await reconcileCodexSubagentTranscript(
      state,
      roster,
      path,
      () => child.offset === previousOffset
    )
    appendFileSync(childPath, started)
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('child')).toBe(true)
    await reconcileCodexSubagentTranscript(state, roster, path)
    expect(roster.has('child')).toBe(true)
    expect(state.subagents.get('child')?.completionSeen).toBe(false)
  })
  it('keeps UTF-8 characters intact across a byte-budget boundary', async () => {
    const path = join(directory(), 'unicode.jsonl')
    writeFileSync(path, line({ text: '😀' }))
    const cursor: JsonlCursor = { filePath: path, offset: 0, carry: '' }
    expect(await readJsonlCursor(cursor, { remaining: 11 })).toEqual([])
    expect(await readJsonlCursor(cursor, { remaining: 100 })).toEqual([{ text: '😀' }])
  })
  it.each([true, false])(
    'waits for child catch-up before deciding completion (restarted=%s)',
    async (restarted) => {
      const dir = directory()
      const path = join(dir, 'parent.jsonl')
      writeFileSync(path, activity('child'))
      writeFileSync(
        join(dir, 'rollout-child.jsonl'),
        line({ type: 'event_msg', payload: { type: 'task_complete' } }) +
          line({ text: 'x'.repeat(200_000) }) +
          line({ text: 'x'.repeat(200_000) }) +
          (restarted ? line({ type: 'event_msg', payload: { type: 'task_started' } }) : '')
      )
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()
      await reconcileCodexSubagentTranscript(state, roster, path)
      expect(roster.has('child')).toBe(true)
      await reconcileCodexSubagentTranscript(state, roster, path)
      expect(roster.has('child')).toBe(restarted)
    }
  )
})
