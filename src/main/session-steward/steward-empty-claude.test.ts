import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import { freshPanes, hookEvent } from '../agent-hooks/fresh-pane-evidence-test-fixtures'
import { proveAiVaultFirstUserPrompt } from '../ai-vault/session-first-user-prompt-proof'
import { agentProcess } from '../session-manage/session-manage-test-fixtures'
import { runStewardPass } from './steward-pass'
import { stewardPersonPrompted, type StewardPromptedSources } from './steward-prompted-runtime'
import { createStewardHarness, fakeSession, type StewardHarness } from './steward-test-fixtures'

const MINUTE = 60_000
const PANE = 'tab-1:leaf-1'
const PID = 4242

let dir: string
let h: StewardHarness
let f: ReturnType<typeof freshPanes>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'steward-empty-claude-'))
  h = createStewardHarness(dir)
  f = freshPanes({ now: h.clock.now })
})
afterEach(async () => {
  f.evidence.dispose()
  await h.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * An agent pane nobody typed into: its hook row names a transcript Claude has not written yet,
 * read through the real transcript proof and the real fresh-pane evidence.
 */
function paneNobodyTypedInto(ago: number, options: { hookPrompt?: string; agent?: string } = {}) {
  const transcriptPath = join(dir, 'not-written-yet.jsonl')
  // Why fixed now: the hook row is the SessionStart report, received before the clock moves.
  const receivedAt = h.clock.now
  const read = stewardPersonPrompted({
    hook: () =>
      ({
        prompt: options.hookPrompt ?? '',
        providerSession: { id: 's1', transcriptPath },
        receivedAt,
        agentPid: PID,
        sessionBoundary: true
      }) as ReturnType<StewardPromptedSources['hook']>,
    prove: (args) => proveAiVaultFirstUserPrompt(args),
    fresh: (paneKey, id) => f.evidence.read(paneKey, id),
    freshStart: (paneKey) => f.evidence.start(paneKey)
  })
  h.deps.tier2.personPrompted = (row, observed) =>
    read(row, { ...observed, agentProcess: agentProcess({ pid: PID, startTimeMs: 1 }) })
  return h.add(
    fakeSession(PANE, {
      lastActivityAt: h.clock.now - ago,
      turn: {
        known: true,
        turnKey: null,
        text: null,
        complete: false,
        proposal: null,
        empty: true
      },
      row: { agent: options.agent ?? 'claude' }
    })
  )
}

const pass = () => runStewardPass(h.deps, h.memory)
const closes = () =>
  h.window.mock.calls.filter(([request]) => {
    const relayed = request as SessionFolderRelayRequest
    return relayed.kind === 'mutate' && relayed.op.kind === 'deleteSession'
  })

describe('blank agent panes, from hook evidence', () => {
  it('closes one after 2 min of continuous evidence, and not before', async () => {
    f.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    paneNobodyTypedInto(MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
    h.clock.now += MINUTE
    await pass()
    expect(closes()).toHaveLength(1)
  })

  it('does not count Claude’s SessionStart done row as a prompt', async () => {
    // Why: SessionStart lands a "done" status row with an empty prompt (the #819 trap).
    f.hook(
      hookEvent({
        paneKey: PANE,
        agentPid: PID,
        payload: { state: 'done', prompt: '', agentType: 'claude', sessionBoundary: true }
      })
    )
    paneNobodyTypedInto(3 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(1)
  })

  it('never closes one with a single typed, unsent character', async () => {
    f.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    f.write(PANE)
    paneNobodyTypedInto(2 * 60 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
  })

  it('reads unknown after a hook-server gap in between, and closes nothing', async () => {
    f.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    f.clock.epoch += 1
    paneNobodyTypedInto(2 * 60 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
  })

  it('never closes one that got a prompt, or a marked one without a transcript', async () => {
    f.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    f.hook(hookEvent({ paneKey: PANE, hookEventName: 'UserPromptSubmit', prompt: 'fix it' }))
    paneNobodyTypedInto(2 * 60 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)

    f.evidence.dispose()
    f = freshPanes({ now: h.clock.now })
    f.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    paneNobodyTypedInto(2 * 60 * MINUTE, { hookPrompt: '[from Session steward] Please continue.' })
    h.memory.seen.clear()
    await pass()
    expect(closes()).toHaveLength(0)
  })

  it('reads unknown with no SessionStart record, and closes nothing', async () => {
    paneNobodyTypedInto(2 * 60 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
  })

  it('closes a blank Gemini pane from its startup SessionStart alone', async () => {
    f.hook(hookEvent({ paneKey: PANE, agentPid: PID, source: 'gemini' }))
    paneNobodyTypedInto(3 * MINUTE, { agent: 'gemini' })
    await pass()
    expect(closes()).toHaveLength(1)
  })
})

describe('blank panes across an app restart', () => {
  it('closes one whose persisted fresh start still holds, with the same agent alive', async () => {
    const store = join(dir, 'fresh-panes.json')
    const before = freshPanes({ now: h.clock.now, store })
    before.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    before.evidence.dispose()
    f = freshPanes({ now: h.clock.now + MINUTE, store })
    paneNobodyTypedInto(3 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(1)
  })

  it('keeps one a hook spooled for while the app was down', async () => {
    const store = join(dir, 'fresh-panes.json')
    const before = freshPanes({ now: h.clock.now, store })
    before.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    before.evidence.dispose()
    f = freshPanes({ now: h.clock.now + MINUTE, store })
    f.clock.drained = true
    paneNobodyTypedInto(3 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
  })

  it('keeps one typed into before the restart', async () => {
    const store = join(dir, 'fresh-panes.json')
    const before = freshPanes({ now: h.clock.now, store })
    before.hook(hookEvent({ paneKey: PANE, agentPid: PID }))
    before.write(PANE)
    before.evidence.dispose()
    f = freshPanes({ now: h.clock.now + MINUTE, store })
    paneNobodyTypedInto(3 * MINUTE)
    await pass()
    expect(closes()).toHaveLength(0)
  })
})
