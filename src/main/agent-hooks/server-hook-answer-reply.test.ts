// Why: locks the hook-first answer replies (PHASE1-SPEC §1/§2): only an accepted hook from the
// holder's pane and launch gets its answer, in each event's own shape, behind one ack line; only
// the hook's acknowledgement counts it injected, once; a blocked Stop is not the end of the turn
// unless never acknowledged and nothing newer was seen; off, nothing new is carried; with nothing
// waiting, every reply is as before.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, GOOD_PANE, PANE, postHookEvent } from './server.test-fixtures'
import { ANSWER_REOFFER_AFTER_MS, AnswerInbox } from '../answer-inbox/answer-inbox'
import { createHookAnswerReplies } from '../answer-inbox/hook-answer-reply'
import { HOOK_ANSWER_ACK_PATHNAME, HOOK_ANSWER_ACK_WAIT_MS } from './hook-answer-gate'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const ANSWER = [
  '[OmniOS decision] Approved: revision 2 of "Plan"',
  'Do now: carry out the plan exactly as approved in revision 2.',
  'Read the saved decision any time: omni artifacts status plan --json'
].join('\n')
const WAIT_PROMPT = 'Wait for Uma to approve on Slack, then close this session'
const LAUNCH = createHash('sha256').update('launch-1').digest('hex')
const HOLDER = { paneKey: PANE, launchHash: LAUNCH, agentPid: null }

let server: AgentHookServer
let inbox: AnswerInbox
let enabled = true
let clock = 1_000

beforeEach(async () => {
  _internals.resetCachesForTests()
  clock = 1_000
  enabled = true
  inbox = new AnswerInbox({ now: () => clock })
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  server.setAnswerReplyProvider(createHookAnswerReplies(inbox, { enabled: () => enabled }))
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
})

function offer(
  provider: 'claude' | 'codex' = 'claude',
  id = 'wd-1',
  holder: typeof HOLDER | null = HOLDER
) {
  return inbox.offer(
    { provider, sessionId: 'conv-1' },
    { id, deliveryKey: `review:plan:${id}`, text: ANSWER, compact: null, holder }
  )
}

type Reply = {
  decision?: string
  reason?: string
  hookSpecificOutput?: { hookEventName: string; additionalContext: string }
}

async function post(path: string, body: unknown) {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-OmniConsole-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: new URLSearchParams(body as Record<string, string>).toString()
  })
}

/** A hook event; an answer reply is acknowledged as the managed script does, unless `ack` is false. */
async function hook(
  payload: Record<string, unknown>,
  source = 'claude',
  overrides: Record<string, unknown> = {},
  ack = true
) {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: 'conv-1', ...payload }, { launchToken: 'launch-1', ...overrides }),
    `/hook/${source}`
  )
  const text = await response.text()
  const [first = '', ...rest] = text.split('\n')
  const token = first.startsWith('omni-answer ') ? first.slice('omni-answer '.length) : null
  const json = token ? rest.join('\n') : text
  if (token && ack) {
    expect((await post(HOOK_ANSWER_ACK_PATHNAME, { ack: token })).status).toBe(204)
  }
  return { status: response.status, token, json: json ? (JSON.parse(json) as Reply) : null }
}

const paneState = () => server.getStatusSnapshotForPane(PANE)[0]?.state

describe('hook-first answer replies', () => {
  it('returns the waiting answer behind one ack line, and counts it only on the hook ack', async () => {
    offer()
    expect((await hook({ hook_event_name: 'PostToolUse', session_id: 'conv-2' })).status).toBe(204)
    const unacked = await hook(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
      'claude',
      {},
      false
    )
    expect(unacked.json).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ANSWER }
    })
    expect(unacked.token).toMatch(/^wd-1 [0-9a-f-]{36}$/)
    expect(inbox.get('wd-1')?.state).toBe('sending')
    expect((await post(HOOK_ANSWER_ACK_PATHNAME, { ack: 'wd-1 forged-nonce' })).status).toBe(204)
    expect(inbox.get('wd-1')?.state).toBe('sending')
    await post(HOOK_ANSWER_ACK_PATHNAME, { ack: unacked.token! })
    expect(inbox.get('wd-1')).toMatchObject({ state: 'injected', injectedBy: 'PostToolUse' })
  })

  it('gives a caller impersonating the holder pane, or another pane, nothing', async () => {
    offer()
    // The shared token, the holder's pane key and conversation id, but not its launch.
    expect(
      (await hook({ hook_event_name: 'PostToolUse' }, 'claude', { launchToken: 'launch-forged' }))
        .status
    ).toBe(204)
    expect(
      (await hook({ hook_event_name: 'PostToolUse' }, 'claude', { paneKey: GOOD_PANE })).status
    ).toBe(204)
    expect(
      (await hook({ hook_event_name: 'PostToolUse' }, 'claude', { launchToken: '' })).status
    ).toBe(204)
    server.dropStatusEntriesByTabPrefix('tab-1')
    expect((await hook({ hook_event_name: 'PostToolUse' })).status).toBe(204)
    expect(inbox.get('wd-1')).toMatchObject({ state: 'offered', attempts: 0 })
  })

  it('matches the transcript a payload names when its session id differs', async () => {
    offer()
    const reply = await hook({
      hook_event_name: 'PostToolUse',
      session_id: 'hook-id',
      transcript_path: '/Users/x/.claude/projects/p/conv-1.jsonl'
    })
    expect(reply.json?.hookSpecificOutput?.additionalContext).toBe(ANSWER)
  })

  it('answers Stop with a block; an answer waiting for a resume goes to nobody until bound', async () => {
    offer('claude', 'wd-1')
    expect((await hook({ hook_event_name: 'SessionStart', source: 'startup' })).status).toBe(204)
    expect((await hook({ hook_event_name: 'Stop', stop_hook_active: false })).json).toEqual({
      decision: 'block',
      reason: ANSWER
    })
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
    expect(inbox.get('wd-1')?.state).toBe('confirmed')
    offer('claude', 'wd-2', null)
    // Why: another pane's valid launch plus the claimed session id is not the resume's pane.
    const otherPane = { paneKey: GOOD_PANE, tabId: 'tab-good', launchToken: 'launch-2' }
    const resume = { hook_event_name: 'SessionStart', source: 'resume' }
    expect((await hook(resume, 'claude', otherPane)).status).toBe(204)
    expect((await hook(resume)).status).toBe(204)
    inbox.bind('wd-2', HOLDER)
    expect((await hook(resume, 'claude', otherPane)).status).toBe(204)
    expect((await hook({ hook_event_name: 'PostToolUse' }, 'claude', otherPane)).status).toBe(204)
    const resumed = await hook(resume)
    expect(resumed.json).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ANSWER }
    })
    expect(inbox.get('wd-2')).toMatchObject({ state: 'injected', holder: HOLDER, attempts: 1 })
  })

  it('carries an unconfirmed answer on a compaction SessionStart without ending the turn', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
    offer()
    const compact = await hook({ hook_event_name: 'SessionStart', source: 'compact' })
    expect(compact.json?.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: ANSWER
    })
    expect(inbox.get('wd-1')).toMatchObject({ state: 'injected', injectedBy: 'SessionStart' })
    expect(paneState()).toBe('working')
  })

  it('keeps the pane working when its Stop is answered and acknowledged', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
    offer()
    expect((await hook({ hook_event_name: 'Stop', stop_hook_active: false })).json?.decision).toBe(
      'block'
    )
    expect(paneState()).toBe('working')
    expect((await hook({ hook_event_name: 'Stop', stop_hook_active: true })).status).toBe(204)
    expect(paneState()).toBe('done')
  })

  it(
    'a blocked Stop never acknowledged ends the turn after the wait, and its answer is offered again',
    async () => {
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
      offer()
      const reply = await hook(
        { hook_event_name: 'Stop', stop_hook_active: false },
        'claude',
        {},
        false
      )
      expect(reply.json?.decision).toBe('block')
      expect(paneState()).toBe('working')
      await new Promise((resolve) => setTimeout(resolve, HOOK_ANSWER_ACK_WAIT_MS + 200))
      expect(paneState()).toBe('done')
      expect(inbox.get('wd-1')).toMatchObject({
        state: 'offered',
        attempts: 0,
        unacked: 1,
        stopOffered: true
      })
      // Why: its one hook copy (and Stop block) was spent when handed out; the typed path repeats it.
      expect((await hook({ hook_event_name: 'Stop', stop_hook_active: true })).status).toBe(204)
      expect((await hook({ hook_event_name: 'Stop', stop_hook_active: false })).status).toBe(204)
      expect((await hook({ hook_event_name: 'PostToolUse' })).status).toBe(204)
    },
    HOOK_ANSWER_ACK_WAIT_MS + 5_000
  )

  it(
    'a blocked Stop never acknowledged is not recorded over a newer step of the pane',
    async () => {
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
      offer()
      const stop = { hook_event_name: 'Stop', stop_hook_active: false }
      expect((await hook(stop, 'claude', {}, false)).json?.decision).toBe('block')
      await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit' })
      expect(paneState()).toBe('working')
      await new Promise((resolve) => setTimeout(resolve, HOOK_ANSWER_ACK_WAIT_MS + 200))
      expect(paneState()).toBe('working')
    },
    HOOK_ANSWER_ACK_WAIT_MS + 5_000
  )

  it(
    'a blocked Stop never acknowledged is not recorded once its pane was closed',
    async () => {
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
      offer()
      const stop = { hook_event_name: 'Stop', stop_hook_active: false }
      expect((await hook(stop, 'claude', {}, false)).json?.decision).toBe('block')
      server.dropStatusEntriesByTabPrefix('tab-1')
      await new Promise((resolve) => setTimeout(resolve, HOOK_ANSWER_ACK_WAIT_MS + 200))
      expect(paneState()).toBeUndefined()
    },
    HOOK_ANSWER_ACK_WAIT_MS + 5_000
  )

  it('a later step before the background ack is kept, and confirms the answer when the ack lands', async () => {
    offer()
    const carried = await hook({ hook_event_name: 'PostToolUse' }, 'claude', {}, false)
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit' })
    await hook({ hook_event_name: 'Stop', stop_hook_active: false })
    expect(inbox.get('wd-1')?.state).toBe('sending')
    await post(HOOK_ANSWER_ACK_PATHNAME, { ack: carried.token! })
    expect(inbox.get('wd-1')).toMatchObject({ state: 'confirmed', attempts: 1 })
  })

  it('an acknowledgement replayed after a re-offer changes nothing', async () => {
    offer()
    const carried = await hook({ hook_event_name: 'PostToolUse' })
    clock += ANSWER_REOFFER_AFTER_MS
    inbox.reofferStale()
    await post(HOOK_ANSWER_ACK_PATHNAME, { ack: carried.token! })
    expect(inbox.get('wd-1')).toMatchObject({ state: 'offered', attempts: 1 })
  })

  it('puts the answer first and keeps the next-step pointer on UserPromptSubmit', async () => {
    offer()
    const reply = await hook({ hook_event_name: 'UserPromptSubmit', prompt: WAIT_PROMPT })
    const context = reply.json?.hookSpecificOutput?.additionalContext ?? ''
    expect(context.startsWith(ANSWER)).toBe(true)
    expect(context).toContain('outcome context --json')
  })

  it('blocks Stop once per item and never loops when stop_hook_active', async () => {
    offer()
    expect((await hook({ hook_event_name: 'Stop', stop_hook_active: false })).json?.decision).toBe(
      'block'
    )
    expect((await hook({ hook_event_name: 'Stop', stop_hook_active: true })).status).toBe(204)
    expect(inbox.get('wd-1')?.state).toBe('confirmed')
    offer('claude', 'wd-2')
    await hook({ hook_event_name: 'PostToolUse' })
    clock += ANSWER_REOFFER_AFTER_MS
    inbox.reofferStale()
    expect((await hook({ hook_event_name: 'Stop', stop_hook_active: true })).status).toBe(204)
    expect(inbox.get('wd-2')).toMatchObject({ state: 'offered', stopOffered: false })
  })

  it('confirms on a later step of the holder, not on a sibling tool result or another pane', async () => {
    offer()
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' })
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Grep' })
    expect(inbox.get('wd-1')?.state).toBe('injected')
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }, 'claude', {
      paneKey: GOOD_PANE
    })
    await hook({ hook_event_name: 'PreToolUse' }, 'claude', { launchToken: 'launch-forged' })
    expect(inbox.get('wd-1')?.state).toBe('injected')
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit' })
    expect(inbox.get('wd-1')?.state).toBe('confirmed')
  })

  it('gives a subagent event nothing', async () => {
    offer()
    expect((await hook({ hook_event_name: 'PostToolUse', agent_id: 'sub-1' })).status).toBe(204)
    expect(inbox.get('wd-1')?.state).toBe('offered')
  })

  it('carries a Codex answer in the shapes Codex accepts', async () => {
    offer('codex')
    expect((await hook({ hook_event_name: 'PostToolUse', turn_id: 't1' }, 'codex')).json).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ANSWER }
    })
    offer('codex', 'wd-2')
    expect(
      (await hook({ hook_event_name: 'Stop', stop_hook_active: false, turn_id: 't1' }, 'codex'))
        .json
    ).toEqual({ decision: 'block', reason: ANSWER })
    offer('codex', 'wd-3')
    expect((await hook({ hook_event_name: 'PostToolUse' })).status).toBe(204)
  })

  it('off: carries nothing new, while an answer already carried still acks and confirms', async () => {
    offer('claude', 'wd-1')
    const carried = await hook({ hook_event_name: 'PostToolUse' }, 'claude', {}, false)
    offer('claude', 'wd-2')
    enabled = false
    expect((await hook({ hook_event_name: 'PostToolUse' })).status).toBe(204)
    expect(inbox.get('wd-2')).toMatchObject({ state: 'offered', attempts: 0 })
    await post(HOOK_ANSWER_ACK_PATHNAME, { ack: carried.token! })
    expect(inbox.get('wd-1')?.state).toBe('injected')
    await hook({ hook_event_name: 'PreToolUse' })
    expect(inbox.get('wd-1')?.state).toBe('confirmed')
  })

  it('leaves every reply exactly as before while nothing is waiting', async () => {
    expect(await hook({ hook_event_name: 'Stop', stop_hook_active: false })).toEqual({
      status: 204,
      token: null,
      json: null
    })
    expect((await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it' })).status).toBe(204)
    const withProvider = await hook({ hook_event_name: 'UserPromptSubmit', prompt: WAIT_PROMPT })
    server.setAnswerReplyProvider(null)
    const without = await hook({ hook_event_name: 'UserPromptSubmit', prompt: WAIT_PROMPT })
    expect(withProvider).toEqual(without)
    expect(without.status).toBe(200)
  })
})

describe('replayed spool records', () => {
  it('a next step spooled while the app was down confirms the answer it follows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-answer-spool-'))
    try {
      const restarted = new AgentHookServer()
      mkdirSync(join(dir, 'agent-hooks', 'spool'), { recursive: true })
      const record = {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        env: 'production',
        launchToken: 'launch-1',
        source: 'claude',
        receivedAt: Date.now(),
        payload: { hook_event_name: 'PreToolUse', session_id: 'conv-1', tool_name: 'Edit' }
      }
      writeFileSync(
        join(dir, 'agent-hooks', 'spool', 'pane-x.jsonl'),
        `\n${JSON.stringify(record)}\n`
      )
      await restarted.start({ env: 'production', userDataPath: dir })
      const restored = new AnswerInbox()
      offer()
      restored.restore({
        ...inbox.get('wd-1')!,
        state: 'injected',
        injectedAt: record.receivedAt - 5_000
      })
      restarted.setAnswerReplyProvider(createHookAnswerReplies(restored, { enabled: () => true }))
      expect(restored.get('wd-1')?.state).toBe('confirmed')
      restarted.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
