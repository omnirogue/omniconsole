// Why: the independent verifier's repros (P1-app B1 and B1-r2) — the generated Claude hook script
// against the real listener. Only the script's own acknowledgement may count an answer injected,
// so a reply the hook already gave up on (a stall before or after dispatch) leaves it waiting.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { getManagedScript } from '../claude/claude-managed-hook-script'
import { AnswerInbox } from '../answer-inbox/answer-inbox'
import { createHookAnswerReplies } from '../answer-inbox/hook-answer-reply'
import { HOOK_ANSWER_ACK_WAIT_MS } from './hook-answer-gate'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const ANSWER =
  '[OmniOS decision] Approved: revision 2 of "Plan"\nDo now: carry out the plan exactly as approved in revision 2.'
const HOLDER = {
  paneKey: PANE,
  launchHash: createHash('sha256').update('launch-1').digest('hex'),
  agentPid: null
}
const SLOW_TEST_MS = 20_000

let server: AgentHookServer
let inbox: AnswerInbox
let home: string
let handlerBusyMs = 0

const busy = (ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* the main process is busy */
  }
}
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  _internals.resetCachesForTests()
  home = mkdtempSync(join(tmpdir(), 'omni-answer-real-'))
  writeFileSync(join(home, 'claude-hook.sh'), getManagedScript('posix'))
  inbox = new AnswerInbox()
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: join(home, 'ud') })
  const real = createHookAnswerReplies(inbox, { enabled: () => true })
  server.setAnswerReplyProvider({
    ...real,
    reply: (input) => {
      busy(handlerBusyMs)
      return real.reply(input)
    }
  })
})

afterEach(() => {
  server.stop()
  handlerBusyMs = 0
  rmSync(home, { recursive: true, force: true })
})

/** A curl on PATH that drops every acknowledgement and passes everything else to the real one. */
function ackDroppingPath(): string {
  const dir = join(home, 'drop-acks')
  mkdirSync(dir, { recursive: true })
  const wrapper = join(dir, 'curl')
  writeFileSync(
    wrapper,
    '#!/bin/sh\ncase "$*" in *ack=*) exit 0 ;; esac\nexec /usr/bin/curl "$@"\n'
  )
  chmodSync(wrapper, 0o755)
  return `${dir}:/usr/bin:/bin`
}

/** Runs the hook; the payload is piped by a shell so a stall here cannot hold its stdin back. */
async function runScript(
  payload: Record<string, unknown>,
  stallBeforeDispatchMs = 0,
  path = '/usr/bin:/bin'
) {
  const env = server.buildPtyEnv()
  const result = await runProcess({
    program: '/bin/sh',
    args: ['-c', 'printf %s "$OMNI_TEST_PAYLOAD" | /bin/sh "$OMNI_TEST_SCRIPT"'],
    cwd: home,
    timeoutMs: 8_000,
    env: {
      PATH: path,
      HOME: home,
      OMNI_TEST_PAYLOAD: JSON.stringify({ session_id: 'conv-1', ...payload }),
      OMNI_TEST_SCRIPT: join(home, 'claude-hook.sh'),
      ...env,
      ORCA_PANE_KEY: PANE,
      ORCA_TAB_ID: 'tab-1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-1'
    },
    onSpawn: () => busy(stallBeforeDispatchMs)
  })
  return { code: result.code, out: result.stdout.trim() }
}

const offer = () =>
  inbox.offer(
    { provider: 'claude', sessionId: 'conv-1' },
    { id: 'wd-1', deliveryKey: 'review:p:d1', text: ANSWER, compact: null, holder: HOLDER }
  )
const item = () => inbox.get('wd-1')
const pane = () => server.getStatusSnapshotForPane(PANE)[0]?.state

describe.skipIf(process.platform === 'win32')('generated Claude hook script, real listener', () => {
  it('a normal fast reply is acknowledged by the script, then confirmed by the next step', async () => {
    offer()
    const carried = await runScript({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })
    expect(JSON.parse(carried.out)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ANSWER }
    })
    await vi.waitFor(() => expect(item()?.state).toBe('injected'), { timeout: 2_000 })
    await runScript({ hook_event_name: 'PreToolUse', tool_name: 'Read' })
    expect(item()?.state).toBe('confirmed')
  })

  it(
    'R2: a 1.8 s stall before dispatch leaves the answer waiting',
    async () => {
      offer()
      const stalled = await runScript({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 1_800)
      expect(stalled).toEqual({ code: 0, out: '{}' })
      expect(item()?.state).not.toBe('injected')
      await runScript({ hook_event_name: 'PreToolUse', tool_name: 'Edit' })
      expect(item()?.state).not.toBe('confirmed')
      await settle(HOOK_ANSWER_ACK_WAIT_MS + 200)
      expect(item()).toMatchObject({ state: 'offered', attempts: 0 })
    },
    SLOW_TEST_MS
  )

  it(
    'R3: a 1.2 s stall before dispatch plus a 0.5 s busy handler leaves the answer waiting',
    async () => {
      offer()
      handlerBusyMs = 500
      const stalled = await runScript({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 1_200)
      handlerBusyMs = 0
      expect(stalled).toEqual({ code: 0, out: '{}' })
      await runScript({ hook_event_name: 'PreToolUse', tool_name: 'Edit' })
      await settle(HOOK_ANSWER_ACK_WAIT_MS + 200)
      expect(item()).toMatchObject({ state: 'offered', attempts: 0 })
    },
    SLOW_TEST_MS
  )

  it(
    'R4: a Stop stalled 1.8 s before dispatch is spooled, ends the turn, and its answer waits',
    async () => {
      await runScript({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
      offer()
      const stalled = await runScript({ hook_event_name: 'Stop', stop_hook_active: false }, 1_800)
      expect(stalled).toEqual({ code: 0, out: '{}' })
      const spool = join(home, 'ud', 'agent-hooks', 'spool')
      expect(existsSync(spool) ? readdirSync(spool).length : 0).toBeGreaterThan(0)
      await settle(HOOK_ANSWER_ACK_WAIT_MS + 500)
      expect(pane()).toBe('done')
      // Why: the block went out unread, so its one hook copy is spent; the typed path repeats it.
      expect(item()).toMatchObject({ state: 'offered', attempts: 0, unacked: 1, stopOffered: true })
      const next = await runScript({ hook_event_name: 'UserPromptSubmit', prompt: 'next thing' })
      expect(next.out).toBe('{}')
      expect(item()?.state).toBe('offered')
    },
    SLOW_TEST_MS
  )

  it(
    'every ack dropped: the answer goes out by hook once (the Stop block), then never again',
    async () => {
      const dropAcks = ackDroppingPath()
      await runScript({ hook_event_name: 'UserPromptSubmit', prompt: 'work on it' })
      offer()
      const step = async (payload: Record<string, unknown>) =>
        (await runScript(payload, 0, dropAcks)).out
      expect(JSON.parse(await step({ hook_event_name: 'Stop', stop_hook_active: false }))).toEqual({
        decision: 'block',
        reason: ANSWER
      })
      await settle(HOOK_ANSWER_ACK_WAIT_MS + 300)
      expect(await step({ hook_event_name: 'Stop', stop_hook_active: true })).toBe('{}')
      expect(await step({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })).toBe('{}')
      expect(await step({ hook_event_name: 'Stop', stop_hook_active: false })).toBe('{}')
      expect(await step({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })).toBe('{}')
      expect(item()).toMatchObject({ state: 'offered', attempts: 0, unacked: 1, stopOffered: true })
    },
    SLOW_TEST_MS
  )
})
