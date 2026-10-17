import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import type { ResolveAutomationFinalOutput } from './automation-output-provenance'
import { createAutomationRunWriter } from './automation-run-writer'

const STARTED_AT = Date.parse('2026-09-20T20:15:00.000Z')
const COMPLETED_AT = STARTED_AT + 60_000
const SELECTOR = { kind: 'self' } as const
const STRUCTURED_OUTPUT = { provider: 'typesafe', contract: 'classification.v1' } as const

function snapshot(
  content: string,
  provenance?: AutomationRunOutputSnapshot['provenance']
): AutomationRunOutputSnapshot {
  return {
    format: 'plain_text',
    content,
    capturedAt: COMPLETED_AT,
    truncated: false,
    ...(provenance ? { provenance } : {})
  }
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Routine run 1',
    scheduledFor: STARTED_AT,
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: 'workspace-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'terminal-1',
    terminalPaneKey: 'pane-1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: STARTED_AT,
    dispatchedAt: STARTED_AT,
    createdAt: STARTED_AT - 1_000,
    ...overrides
  }
}

function harness({
  optedIn = true,
  run = makeRun()
}: { optedIn?: boolean; run?: AutomationRun } = {}) {
  let current = run
  const automation = {
    id: current.automationId,
    ...(optedIn ? { structuredOutput: STRUCTURED_OUTPUT } : {})
  } as Automation
  const store = {
    listAutomationRuns: vi.fn<Store['listAutomationRuns']>(() => [current]),
    listAutomations: vi.fn<Store['listAutomations']>(() => [automation]),
    updateAutomationRun: vi.fn<Store['updateAutomationRun']>((result) => {
      const {
        runId: _runId,
        providerSession: _providerSession,
        resume: _resume,
        ...fields
      } = result
      current = { ...current, ...fields }
      return current
    }),
    automationChangeSelector: vi.fn(() => SELECTOR)
  }
  const publish = vi.fn()
  const readRollout = vi.fn<(path: string) => string | null>(() => null)
  const resolveFinalOutput = vi.fn<ResolveAutomationFinalOutput>(() => null)
  const writer = createAutomationRunWriter(
    store as unknown as Store,
    publish,
    readRollout,
    resolveFinalOutput
  )
  return { store, publish, readRollout, resolveFinalOutput, writer }
}

function completed(overrides: Partial<AutomationDispatchResult> = {}): AutomationDispatchResult {
  return { runId: 'run-1', status: 'completed', ...overrides }
}

function rollout(message: string): string {
  return JSON.stringify({
    timestamp: new Date(COMPLETED_AT).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: message }
  })
}

describe('automation run writer output provenance', () => {
  it('strips a renderer assistant claim before resolving or persisting it', () => {
    const { writer, store, resolveFinalOutput } = harness()
    const claimed = snapshot('Renderer-supplied report', 'assistant_message')
    const input = completed({ outputSnapshot: claimed })

    const result = writer.updateRun(input)

    expect(resolveFinalOutput).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }), {
      ...input,
      outputSnapshot: snapshot(claimed.content)
    })
    expect(store.updateAutomationRun).toHaveBeenCalledWith({
      ...input,
      outputSnapshot: snapshot(claimed.content)
    })
    expect(result.outputSnapshot).not.toHaveProperty('provenance')
    expect(input.outputSnapshot).toBe(claimed)
    expect(claimed.provenance).toBe('assistant_message')
  })

  it('uses exact native proof without reading a stored Codex transcript path when opted in', () => {
    const run = makeRun({
      providerSessionAgent: 'codex',
      providerSessionTranscriptPath: '/fixture/rollout.jsonl'
    })
    const { writer, store, readRollout, resolveFinalOutput, publish } = harness({ run })
    const proven = snapshot(
      '  {"decision":"keep"}\n\nFinal assistant message.\n',
      'assistant_message'
    )
    readRollout.mockReturnValue(rollout('Untrusted persisted-path report'))
    resolveFinalOutput.mockReturnValue(proven)
    const input = completed({
      outputSnapshot: {
        ...snapshot('Wrapped terminal capture', 'terminal_capture'),
        truncated: true
      }
    })

    const result = writer.updateRun(input)

    expect(readRollout).not.toHaveBeenCalled()
    expect(resolveFinalOutput).toHaveBeenCalledWith(run, input)
    expect(store.updateAutomationRun).toHaveBeenCalledWith({ ...input, outputSnapshot: proven })
    expect(result.outputSnapshot).toBe(proven)
    expect(result.status).toBe('completed')
    expect(publish).toHaveBeenCalledWith({ reason: 'run', selector: SELECTOR })
  })

  it.each(['pending', 'dispatching', 'dispatched', 'dispatch_failed'] as const)(
    'never resolves proof for a %s write and removes incoming assistant claims',
    (status) => {
      const { writer, resolveFinalOutput, readRollout } = harness()
      const input = completed({
        status,
        outputSnapshot: snapshot('Incoming text', 'assistant_message')
      })

      const result = writer.updateRun(input)

      expect(resolveFinalOutput).not.toHaveBeenCalled()
      expect(readRollout).not.toHaveBeenCalled()
      expect(result.status).toBe(status)
      expect(result.outputSnapshot).toEqual(snapshot('Incoming text'))
    }
  )

  it('does not resolve a completed run that is missing from storage', () => {
    const { writer, store, resolveFinalOutput } = harness()
    store.listAutomationRuns.mockReturnValue([])
    const input = completed({ outputSnapshot: snapshot('Ordinary report') })

    writer.updateRun(input)

    expect(resolveFinalOutput).not.toHaveBeenCalled()
    expect(store.updateAutomationRun).toHaveBeenCalledWith(input)
  })

  it.each(['missing', 'another routine opted in'])(
    'does not resolve when the matching automation is %s',
    (setting) => {
      const { writer, store, resolveFinalOutput } = harness()
      store.listAutomations.mockReturnValue(
        setting === 'missing'
          ? []
          : [{ id: 'other-automation', structuredOutput: STRUCTURED_OUTPUT } as Automation]
      )
      const input = completed({ outputSnapshot: snapshot('Ordinary report') })

      writer.updateRun(input)

      expect(resolveFinalOutput).not.toHaveBeenCalled()
      expect(store.updateAutomationRun).toHaveBeenCalledWith(input)
    }
  )

  it('keeps an Off routine result and completion status unchanged without resolving proof', () => {
    const { writer, store, resolveFinalOutput } = harness({ optedIn: false })
    resolveFinalOutput.mockReturnValue(snapshot('Must not be used', 'assistant_message'))
    const input = completed({
      outputSnapshot: snapshot('Ordinary terminal output', 'terminal_capture'),
      error: null,
      terminalPaneKey: 'pane-1'
    })

    const result = writer.updateRun(input)

    expect(resolveFinalOutput).not.toHaveBeenCalled()
    expect(store.updateAutomationRun).toHaveBeenCalledWith(input)
    expect(result).toMatchObject({ status: input.status, outputSnapshot: input.outputSnapshot })
  })

  it('strips a forged assistant claim even when the routine is Off', () => {
    const { writer, store, resolveFinalOutput } = harness({ optedIn: false })

    writer.updateRun(completed({ outputSnapshot: snapshot('Claimed report', 'assistant_message') }))

    expect(resolveFinalOutput).not.toHaveBeenCalled()
    expect(store.updateAutomationRun).toHaveBeenCalledWith(
      completed({ outputSnapshot: snapshot('Claimed report') })
    )
  })

  it('retains ordinary Codex rollout reconciliation for an Off routine', () => {
    const run = makeRun({
      providerSessionAgent: 'codex',
      providerSessionTranscriptPath: '/fixture/ordinary-rollout.jsonl'
    })
    const { writer, store, readRollout, resolveFinalOutput } = harness({ optedIn: false, run })
    readRollout.mockReturnValue(rollout('Ordinary reconciled report'))
    const input = completed({ outputSnapshot: snapshot('Wrapped terminal report') })

    const result = writer.updateRun(input)

    expect(readRollout).toHaveBeenCalledWith('/fixture/ordinary-rollout.jsonl')
    expect(resolveFinalOutput).not.toHaveBeenCalled()
    expect(store.updateAutomationRun).toHaveBeenCalledWith({
      ...input,
      outputSnapshot: snapshot('Ordinary reconciled report')
    })
    expect(result.status).toBe('completed')
    expect(result.outputSnapshot).not.toHaveProperty('provenance')
  })

  it.each([undefined, 'terminal_capture'] as const)(
    'retains %s provenance when native proof is unavailable',
    (provenance) => {
      const { writer, store, resolveFinalOutput, readRollout } = harness({
        run: makeRun({
          providerSessionAgent: 'codex',
          providerSessionTranscriptPath: '/fixture/untrusted-rollout.jsonl'
        })
      })
      readRollout.mockReturnValue(rollout('Must not replace the unproven report'))
      const input = completed({ outputSnapshot: snapshot('Unproven report', provenance) })

      const result = writer.updateRun(input)

      expect(resolveFinalOutput).toHaveBeenCalledOnce()
      expect(readRollout).not.toHaveBeenCalled()
      expect(store.updateAutomationRun).toHaveBeenCalledWith(input)
      expect(result.outputSnapshot).toBe(input.outputSnapshot)
    }
  )

  it('keeps an omitted snapshot absent when native proof is unavailable', () => {
    const { writer, store, resolveFinalOutput } = harness()
    const input = completed()

    const result = writer.updateRun(input)

    expect(resolveFinalOutput).toHaveBeenCalledOnce()
    expect(store.updateAutomationRun).toHaveBeenCalledWith(input)
    expect(store.updateAutomationRun.mock.calls[0][0]).not.toHaveProperty('outputSnapshot')
    expect(result.outputSnapshot).toBeNull()
  })

  it('keeps the ordinary completion unproven when the native resolver throws', () => {
    const { writer, store, resolveFinalOutput } = harness()
    resolveFinalOutput.mockImplementation(() => {
      throw new Error('Native transcript is unavailable')
    })
    const input = completed({ outputSnapshot: snapshot('Ordinary report', 'assistant_message') })

    const result = writer.updateRun(input)

    expect(result.status).toBe('completed')
    expect(store.updateAutomationRun).toHaveBeenCalledWith(
      completed({ outputSnapshot: snapshot('Ordinary report') })
    )
  })

  it('does not attach proof after reconciliation rejects a dead terminal completion', () => {
    const { writer, resolveFinalOutput } = harness()
    resolveFinalOutput.mockReturnValue(snapshot('Must not be accepted', 'assistant_message'))

    const result = writer.updateRun(
      completed({
        outputSnapshot: snapshot('This conversation is open in another app  R to Retry')
      })
    )

    expect(result.status).toBe('dispatch_failed')
    expect(result.error).toContain('open in another app')
    expect(resolveFinalOutput).not.toHaveBeenCalled()
    expect(result.outputSnapshot).not.toHaveProperty('provenance')
  })

  it('supports the optional resolver seam without trusting incoming claims', () => {
    const { store, publish, readRollout } = harness({
      run: makeRun({
        providerSessionAgent: 'codex',
        providerSessionTranscriptPath: '/fixture/untrusted-rollout.jsonl'
      })
    })
    readRollout.mockReturnValue(rollout('Must not replace the unproven report'))
    const writer = createAutomationRunWriter(store as unknown as Store, publish, readRollout)

    const result = writer.updateRun(
      completed({ outputSnapshot: snapshot('Unproven report', 'assistant_message') })
    )

    expect(result.outputSnapshot).toEqual(snapshot('Unproven report'))
    expect(readRollout).not.toHaveBeenCalled()
  })

  it.each(['usage', 'terminal clear'] as const)(
    'preserves a stored confirmed message through a later no-output %s write',
    (kind) => {
      const run = makeRun({
        providerSessionAgent: 'codex',
        providerSessionTranscriptPath: '/fixture/rollout.jsonl'
      })
      const { writer, store, readRollout, resolveFinalOutput, publish } = harness({ run })
      const proven = snapshot('Original confirmed assistant message', 'assistant_message')
      resolveFinalOutput.mockReturnValueOnce(proven)
      writer.updateRun(completed({ outputSnapshot: snapshot('First terminal capture') }))
      readRollout.mockReturnValue(rollout('Later rollout content must not replace the proof'))
      const update = completed(
        kind === 'usage'
          ? { usage: { status: 'known', totalTokens: 42 } as AutomationRun['usage'] }
          : { terminalSessionId: null, terminalPaneKey: null, terminalPtyId: null }
      )

      const result = writer.updateRun(update)

      expect(resolveFinalOutput).toHaveBeenCalledOnce()
      expect(readRollout).not.toHaveBeenCalled()
      expect(store.updateAutomationRun).toHaveBeenLastCalledWith({
        ...update,
        outputSnapshot: proven
      })
      expect(result.outputSnapshot).toBe(proven)
      expect(result.status).toBe('completed')
      expect(publish).toHaveBeenLastCalledWith({
        reason: kind === 'usage' ? 'usage' : 'run',
        selector: SELECTOR
      })
    }
  )
})
