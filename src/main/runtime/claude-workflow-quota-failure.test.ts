import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readClaudeWorkflowQuotaFailure } from './claude-workflow-quota-failure'

const dirs: string[] = []
const sessionId = 'provider-session'
const agentId = 'ad4e76b90a9128b2b'
const failedAt = Date.now()
const at = (time: number) => new Date(time).toISOString()
const jsonl = (row: object) => `${JSON.stringify(row)}\n`

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'claude-quota-'))
  dirs.push(home)
  const project = join(home, 'projects', 'repo')
  const children = join(project, sessionId, 'subagents')
  const workflow = join(children, 'workflows', 'wf_test')
  mkdirSync(workflow, { recursive: true })
  const parent = join(project, `${sessionId}.jsonl`)
  const child = join(children, `agent-${agentId}.jsonl`)
  const journal = join(workflow, 'journal.jsonl')
  const error = {
    type: 'assistant',
    isSidechain: true,
    isApiErrorMessage: true,
    sessionId,
    agentId,
    timestamp: at(failedAt),
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets 6pm" }] },
    quotaLimits: {
      status: 'rejected',
      rateLimitType: 'seven_day',
      overageDisabledReason: 'out_of_credits'
    }
  }
  writeFileSync(
    parent,
    jsonl({
      type: 'user',
      sessionId,
      timestamp: at(failedAt - 1000),
      message: { content: 'Finish setup.' }
    })
  )
  writeFileSync(child, jsonl(error))
  writeFileSync(journal, jsonl({ type: 'started', key: 'verify', agentId }))
  const read = () => readClaudeWorkflowQuotaFailure(parent, sessionId, failedAt - 1000)
  return { home, parent, child, journal, error, read }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude workflow quota evidence', () => {
  it('reads a pending child rejection without a failed parent turn', () => {
    const f = fixture()
    expect(f.read()).toEqual({
      failedAt,
      reason: f.error.message.content[0]!.text,
      childTranscriptPath: f.child
    })
    appendFileSync(f.child, jsonl({ type: 'attachment', timestamp: at(failedAt + 1) }))
    expect(f.read()?.failedAt).toBe(failedAt)
    appendFileSync(
      f.journal,
      jsonl({ type: 'result', key: 'verify', agentId, result: 'Verified.' })
    )
    expect(f.read()).toBeNull()
  })

  it.each(['assistant', 'user'])('rejects quota superseded by a child %s record', (type) => {
    const f = fixture()
    appendFileSync(
      f.child,
      jsonl({ type, timestamp: at(failedAt + 1), message: { content: 'Continue.' } })
    )
    expect(f.read()).toBeNull()
  })

  it('rejects newer parent input and hook turns, but permits tool results', () => {
    const f = fixture()
    appendFileSync(
      f.parent,
      jsonl({
        type: 'user',
        sessionId,
        timestamp: at(failedAt + 1),
        message: { content: [{ type: 'tool_result', content: 'Result' }] }
      })
    )
    expect(f.read()).not.toBeNull()
    expect(readClaudeWorkflowQuotaFailure(f.parent, sessionId, failedAt + 1)).toBeNull()
    appendFileSync(
      f.parent,
      jsonl({
        type: 'user',
        sessionId,
        timestamp: at(failedAt + 1),
        message: { content: 'New request' }
      })
    )
    expect(f.read()).toBeNull()
  })

  it.each([
    { isApiErrorMessage: false },
    { agentId: 'other' },
    { sessionId: 'other' },
    { isSidechain: false },
    { timestamp: 'invalid' },
    { error: 'authentication_failed' },
    {
      quotaLimits: undefined,
      message: { content: [{ type: 'text', text: 'Rate limit reached. Retrying.' }] }
    }
  ])('rejects unbound or non-quota evidence %j', (change) => {
    const f = fixture()
    writeFileSync(f.child, jsonl({ ...f.error, ...change }))
    expect(f.read()).toBeNull()
  })

  it('fails closed on partial records, unreadable journals and traversal identities', () => {
    const f = fixture()
    appendFileSync(f.child, '{"type":"assistant"')
    expect(f.read()).toBeNull()
    writeFileSync(f.child, jsonl(f.error))
    appendFileSync(f.journal, '{"type":"result"')
    expect(f.read()).toBeNull()
    writeFileSync(f.journal, jsonl({ type: 'started', key: 'verify', agentId: '../outside' }))
    expect(f.read()).toBeNull()
    expect(readClaudeWorkflowQuotaFailure(f.parent, 'other', failedAt - 1000)).toBeNull()
  })

  it('reads bounded tails without parsing a partial first record', () => {
    const f = fixture()
    writeFileSync(
      f.child,
      jsonl({ type: 'assistant', message: { content: 'x'.repeat(300_000) } }) + jsonl(f.error)
    )
    expect(f.read()?.failedAt).toBe(failedAt)
  })

  it('bounds child probes across workflow journals on a host tick', () => {
    const f = fixture()
    appendFileSync(
      f.journal,
      Array.from({ length: 128 }, (_, i) =>
        jsonl({ type: 'started', key: `task-${i}`, agentId: `a${i}` })
      ).join('')
    )
    expect(f.read()).toBeNull()
  })

  it('does not revive a quota wall after its provider-reported reset', () => {
    const f = fixture()
    const writeReset = (resetsAt: number) =>
      writeFileSync(
        f.child,
        jsonl({
          ...f.error,
          quotaLimits: { ...f.error.quotaLimits, resetsAt }
        })
      )
    writeReset(Date.now() / 1_000 - 1)
    expect(f.read()).toBeNull()
    writeReset(Date.now() / 1_000 + 60)
    expect(f.read()?.failedAt).toBe(failedAt)
    writeReset(Number.NaN)
    expect(f.read()).toBeNull()
  })
})
