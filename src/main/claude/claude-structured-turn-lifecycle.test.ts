// One structured Claude turn, end to end, with the agent SDK replaced by a scripted
// connection: prompt -> tool call -> permission request -> result.
//
// Why a whole-turn test on top of the per-stage ones: every stage below is already
// covered in isolation, and a lane can still be broken while all of them pass — the
// journal identities the translator mints are what the host answers a permission
// against, so a stage that is individually correct but hands the next one a key it
// does not recognise leaves a prompt nobody can answer. Only a run through the real
// adapter with the real translator behind it observes that seam.

import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  invokeCanUseTool,
  PROVIDER_SESSION_ID,
  tick,
  USER_MESSAGE
} from './claude-structured-session-test-support'

type Appended = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

function journalSink(): {
  sink: StructuredAgentSessionEventSink
  items: Appended[]
  tombstones: AgentJournalItemIdentity[]
} {
  const items: Appended[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  return {
    items,
    tombstones,
    sink: {
      appendItem: (identity, body) => items.push({ identity, body }),
      appendTombstone: (identity) => tombstones.push(identity),
      publish: vi.fn()
    }
  }
}

function assistantToolUse(uuid: string, toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }]
    }
  }
}

function toolResult(uuid: string, toolUseId: string, content: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: toolUseId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }]
    }
  }
}

/** The last body appended under `key`, or undefined when the turn never minted it. */
function latest(items: Appended[], key: string): AgentJournalItemBody | undefined {
  return items.findLast((item) => agentJournalItemKey(item.identity) === key)?.body
}

describe('a structured Claude turn, end to end', () => {
  it('journals prompt, tool call, permission and result through one adapter', async () => {
    const claude = fakeClaude()
    const journal = journalSink()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journal.sink
    })
    const connection = claude.connections[0]!

    // 1. The prompt. `accepted` is the provider's own replay echo, not our optimism:
    //    the scripted connection replays the user frame with the uuid the turn keys on.
    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(outcome).toEqual({
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: 'user-uuid-0' }
    })
    const turnKey = agentJournalItemKey({
      provider: 'legacy',
      agent: 'claude',
      sessionId: PROVIDER_SESSION_ID,
      recordId: 'turn-lifecycle:user-uuid-0'
    })
    expect(latest(journal.items, turnKey)).toMatchObject({
      kind: 'status',
      turnLifecycle: { turnId: 'user-uuid-0', state: 'running' }
    })

    // 2. The tool call, still running: no result frame has landed for it yet.
    connection.handlers.onMessage?.(assistantToolUse('assistant-1', 'tool-1'))
    const toolKey = agentJournalItemKey({
      provider: 'omni',
      clientMessageId: `claude-tool:${PROVIDER_SESSION_ID}:tool-1`
    })
    expect(latest(journal.items, toolKey)).toMatchObject({
      kind: 'tool-call',
      name: 'Bash',
      state: 'running'
    })

    // 3. The permission request the SDK blocks on. It must arrive as a durable,
    //    addressable journal row — a prompt only the in-memory registry knew about
    //    would be unanswerable the moment a client reattached.
    const answered = invokeCanUseTool(connection, 'Bash', 'permission-1', 'tool-1', {
      input: { command: 'ls' }
    })
    const approval = journal.items.at(-1)!
    expect(approval.body).toMatchObject({
      kind: 'approval',
      title: 'Allow Bash?',
      resolution: { state: 'pending' }
    })
    expect(answered.settled()).toBe(false)

    // 4. The answer, addressed by the journal id the host holds — not by the
    //    provider's request id, which no client ever sees.
    adapter.bindPromptItemId('session-1', agentJournalItemKey(approval.identity), 'permission-1')
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: agentJournalItemKey(approval.identity),
      kind: 'approval',
      optionId: 'allow',
      fence: 7
    })
    await expect(answered.promise).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1'
    })

    // 5. The tool's own result closes the row the tool_use opened, in place.
    connection.handlers.onMessage?.(toolResult('tool-result-1', 'tool-1', 'a.ts\nb.ts'))
    expect(latest(journal.items, toolKey)).toMatchObject({
      kind: 'tool-call',
      state: 'completed',
      output: { head: 'a.ts\nb.ts', truncated: false }
    })

    // 6. The result frame ends the turn: the running-lifecycle row is tombstoned
    //    rather than left behind as a spinner nothing will ever stop.
    connection.handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'result-1'
    })
    await tick()
    expect(journal.tombstones.map(agentJournalItemKey)).toContain(turnKey)
  })

  it('never authorizes a tool after the provider withdrew the request', async () => {
    const claude = fakeClaude()
    const journal = journalSink()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journal.sink
    })
    const controller = new AbortController()
    const answered = invokeCanUseTool(claude.connections[0]!, 'Bash', 'permission-2', 'tool-2', {
      input: { command: 'rm -rf /' },
      signal: controller.signal
    })
    const approval = journal.items.at(-1)!
    adapter.bindPromptItemId('session-1', agentJournalItemKey(approval.identity), 'permission-2')

    controller.abort()
    // Null, never `{behavior:'allow'}`: a withdrawn request that answers "allow"
    // would authorize a command the person was never shown.
    await expect(answered.promise).resolves.toBeNull()
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: agentJournalItemKey(approval.identity),
        kind: 'approval',
        optionId: 'allow',
        fence: 7
      })
    ).rejects.toThrow(/no longer waiting/)
  })
})
