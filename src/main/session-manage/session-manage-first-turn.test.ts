import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { continueSession } from './session-manage-continue'
import type { SessionDeliveryDeps } from './session-manage-deliver'
import {
  latestTurnFromMessages,
  readTranscriptLatestTurn,
  withTranscriptFirstTurn
} from './session-manage-first-turn'
import { conversationFence, UNREAD_TURN, type SessionLatestTurn } from './session-manage-freeform'
import { SessionManageRefusal } from './session-manage-refusal'
import { agentProcess, manageEntry } from './session-manage-test-fixtures'

const message = (id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'first-turn-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('latestTurnFromMessages', () => {
  it('is the replies after the last prompt, whole', () => {
    const turn = latestTurnFromMessages(
      [
        message('u1', 'user', 'Fix the parser'),
        message('a1', 'assistant', 'Looking.'),
        message('t1', 'tool', ''),
        message('a2', 'assistant', 'Fixed and pushed the branch parser-fix.')
      ],
      'completed'
    )
    expect(turn).toMatchObject({
      known: true,
      text: 'Looking.\n\nFixed and pushed the branch parser-fix.',
      complete: true,
      proposal: null,
      empty: false
    })
    expect(turn.turnKey).toMatch(/^transcript:[0-9a-f]{32}$/)
  })

  it('carries the reply’s own proposal so a free prompt is refused on it', () => {
    const turn = latestTurnFromMessages(
      [
        message('u1', 'user', 'Fix the parser'),
        message(
          'a1',
          'assistant',
          'Done.\n\nNext steps:\n1. Add tests for the export path\n2. Update the docs'
        )
      ],
      null
    )
    expect(JSON.parse(turn.proposal!)).toHaveLength(2)
  })

  it.each([
    [
      'a turn still working',
      [message('u1', 'user', 'go'), message('a1', 'assistant', 'hi')],
      'working'
    ],
    [
      'an interrupted turn',
      [message('u1', 'user', 'go'), message('s1', 'system', 'Conversation interrupted')],
      null
    ],
    [
      'a prompt with no reply',
      [message('a0', 'assistant', 'old'), message('u1', 'user', 'go')],
      null
    ],
    ['a reply longer than the tail', [message('a1', 'assistant', 'part')], null]
  ] as const)('is not read whole for %s', (_name, messages, lifecycle) => {
    const turn = latestTurnFromMessages(messages, lifecycle)
    expect(turn).toMatchObject({ known: true, turnKey: null, complete: false })
  })
})

describe('readTranscriptLatestTurn', () => {
  it('reads a Claude transcript from its end', async () => {
    const path = join(dir, 's.jsonl')
    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix the parser' } },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] }
      }
    ]
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    expect(await readTranscriptLatestTurn('claude', path)).toMatchObject({
      known: true,
      text: 'Fixed it.',
      complete: true
    })
  })
})

describe('the first task for a just-resumed conversation', () => {
  const source: ConversationSource = {
    kind: 'pty',
    paneKey: 'tab-9:leaf-9',
    worktreeId: 'w'
  } as ConversationSource
  const hostHasNoTurn: SessionLatestTurn = { ...UNREAD_TURN, known: true }

  function base(host: {
    turn: SessionLatestTurn
  }): SessionDeliveryDeps & { enqueue: Mock<SessionDeliveryDeps['enqueue']> } {
    return {
      enqueue: vi.fn<SessionDeliveryDeps['enqueue']>(),
      admission: () => null,
      bind: () => () => {},
      readLatestTurn: async () => host.turn,
      snapshotLatestTurn: () => host.turn,
      hasUnresolvedDraft: () => false,
      decideRelayed: async () => {
        throw new Error('unused')
      },
      stopKeepGoing: () => false,
      readOwnSteps: async () => ({ known: true, sets: [], steps: [] }) as never,
      newId: () => 'id-1'
    }
  }

  const target = {
    entry: manageEntry({ paneKey: 'tab-9:leaf-9', state: 'idle' }),
    source,
    agentProcess: agentProcess()
  }

  it('is refused on the host’s own reading alone, since the host never watched it reply', async () => {
    const deps = base({ turn: hostHasNoTurn })
    await expect(
      continueSession(deps, {
        actor: { kind: 'cli' },
        target,
        answer: { kind: 'prompt', text: 'Add retry to the export path' },
        dryRun: false
      })
    ).rejects.toThrow('could not be read in full')
  })

  it('is sent after its transcript’s finished reply, fenced so a newer turn revokes it', async () => {
    const host = { turn: hostHasNoTurn }
    const deps = base(host)
    let binding: {
      conversationStill?: () => boolean
      conversationGuard?: () => Promise<string | null>
    } = {}
    deps.bind = (_source, _entry, bound) => {
      binding = bound
      return () => {}
    }
    const transcript = latestTurnFromMessages(
      [message('u1', 'user', 'Fix the parser'), message('a1', 'assistant', 'Fixed it and pushed.')],
      'completed'
    )
    const { entryId } = await continueSession(
      withTranscriptFirstTurn(deps, async () => transcript),
      {
        actor: { kind: 'cli' },
        target,
        answer: { kind: 'prompt', text: 'Add retry to the export path' },
        dryRun: false
      }
    )
    expect(entryId).toBe('session-manage:id-1')
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(binding.conversationStill?.()).toBe(true)
    expect(await binding.conversationGuard?.()).toBeNull()
    // The agent answered something else meanwhile: the host now holds that turn.
    host.turn = { ...transcript, turnKey: 'host-turn', text: 'Something new' }
    expect(binding.conversationStill?.()).toBe(false)
    expect(await binding.conversationGuard?.()).toContain('changed after this was checked')
    expect(conversationFence(transcript, true)).not.toBe(conversationFence(host.turn, true))
  })

  it('still refuses a transcript reply that asks something', async () => {
    const deps = base({ turn: hostHasNoTurn })
    const transcript = latestTurnFromMessages(
      [
        message('u1', 'user', 'Fix the parser'),
        message('a1', 'assistant', 'Should I also fix the docs?')
      ],
      'completed'
    )
    const sending = continueSession(
      withTranscriptFirstTurn(deps, async () => transcript),
      {
        actor: { kind: 'cli' },
        target,
        answer: { kind: 'prompt', text: 'Add retry to the export path' },
        dryRun: false
      }
    )
    await expect(sending).rejects.toBeInstanceOf(SessionManageRefusal)
    await expect(sending).rejects.toThrow(/proposes next steps|ends on a question/)
    expect(deps.enqueue).not.toHaveBeenCalled()
  })
})
