import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { ANSWER_DELIVERY_PILOT_FILE } from '../../shared/answer-delivery-pilot-report'
import {
  workDeliveryQueueId,
  type WorkDeliveryDeps,
  type WorkPane
} from '../work-delivery/work-delivery-claimer-types'
import type { ClaimableDelivery } from '../work-delivery/work-delivery-kind'
import { installHookFirstAnswers } from './answer-inbox-install'
import type { AgentHookAnswerReplies } from './hook-answer-reply'

const PANE: WorkPane = { paneKey: 'p', worktreeId: 'w', tabId: 't', archived: false, title: 'x' }
const TARGET = { ref: 'codex:thread-1@local', transcript: 'present' as const }
const DELIVERY = { key: 'question:7:a1', kind: 'question', context: {} } as ClaimableDelivery
const TEXT = '[OmniOS answer] Answered in OmniOS\nDo now: continue with these answers.'
const PENDING = 'answer-inbox-pending.json'

function base(): WorkDeliveryDeps {
  return {
    api: { receipt: vi.fn(async () => ({ status: 'ok' as const, value: {} })) },
    adapters: new Map(),
    enqueue: vi.fn(async () => true),
    findHolder: vi.fn(async () => ({ kind: 'live' as const, pane: PANE })),
    queueState: () => 'missing',
    busy: vi.fn(async () => true),
    audit: () => {}
  } as unknown as WorkDeliveryDeps
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('installHookFirstAnswers', () => {
  it('installs the reply provider, and with the setting off writes nothing and types as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-answer-inbox-'))
    const hookServer = { setAnswerReplyProvider: vi.fn() }
    const installed = installHookFirstAnswers({
      userDataPath: dir,
      settings: () => ({}),
      hookServer
    })
    expect(hookServer.setAnswerReplyProvider).toHaveBeenCalledWith(
      expect.objectContaining({ reply: expect.any(Function), confirm: expect.any(Function) })
    )
    const inner = base()
    const deps = installed.router.wrap(inner)
    await deps.enqueue(PANE, TARGET, 'wd-1', TEXT, DELIVERY)
    expect(inner.enqueue).toHaveBeenCalledWith(PANE, TARGET, 'wd-1', TEXT, DELIVERY)
    await flush()
    installed.stop()
    expect(existsSync(join(dir, PENDING))).toBe(false)
    expect(existsSync(join(dir, ANSWER_DELIVERY_PILOT_FILE))).toBe(false)
    expect(hookServer.setAnswerReplyProvider).toHaveBeenLastCalledWith(null)
  })

  it('saves a handed-over answer at once, flushes later changes on quit, and restores it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-answer-inbox-'))
    const settings = () => ({ answerDelivery: { hookFirst: true } })
    let replies: AgentHookAnswerReplies | null = null
    const launchHash = createHash('sha256').update('l').digest('hex')
    const first = installHookFirstAnswers({
      userDataPath: dir,
      settings,
      hookServer: { setAnswerReplyProvider: (value) => (replies ??= value) },
      holderIdentity: async (pane) => ({ paneKey: pane.paneKey, launchHash, agentPid: null })
    })
    const inner = base()
    const id = workDeliveryQueueId(DELIVERY.key)
    const deps = first.router.wrap(inner)
    // as the claimer does: the holder lookup, then the handover
    await deps.findHolder(TARGET)
    expect(await deps.enqueue(PANE, TARGET, id, TEXT, DELIVERY)).toBe(true)
    expect(inner.enqueue).not.toHaveBeenCalled()
    // the claimer reports `queued` next, so the route is on disk before that
    expect(readFileSync(join(dir, PENDING), 'utf8')).toContain(`"phase":"hook"`)
    const reply = replies!.reply({
      source: 'codex',
      body: { payload: { hook_event_name: 'PostToolUse', session_id: 'thread-1' } },
      event: { paneKey: 'p', launchToken: 'l', connectionId: null } as AgentHookEventPayload,
      pointer: null,
      deliverable: () => true
    })
    replies!.ack(reply!.ack)
    first.stop()
    expect(readFileSync(join(dir, PENDING), 'utf8')).toContain(`"state":"injected"`)
    await vi.waitFor(() =>
      expect(readFileSync(join(dir, ANSWER_DELIVERY_PILOT_FILE), 'utf8')).toContain(
        '"outcome":"open"'
      )
    )

    const second = installHookFirstAnswers({
      userDataPath: dir,
      settings,
      hookServer: { setAnswerReplyProvider: vi.fn() }
    })
    expect(second.router.wrap(base()).queueState(PANE, id)).toBe('queued')
    expect(second.router.route(id)).toMatchObject({ conversation: { provider: 'codex' } })
    second.stop()
  })
})
