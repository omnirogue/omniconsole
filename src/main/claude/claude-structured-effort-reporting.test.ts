import { describe, expect, it } from 'vitest'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import {
  restoreClaudeStructuredSessionOptions,
  setClaudeStructuredOption
} from './claude-structured-options'
import { readClaudeSettingsEffort } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import { acquired, fakeClaude } from './claude-structured-session-test-support'

/** Verbatim from Claude Code 2.1.258's get_settings response. */
const REAL_SETTINGS = {
  applied: { model: 'claude-opus-5[1m]', effort: 'high', advisor: null, ultracode: false },
  effective: { model: 'claude-opus-5[1m]', effortLevel: 'high', env: {} },
  sources: {}
}

function sessionWith(
  reported: string | null,
  calls: string[] = [],
  listed?: { model: string; catalog: readonly Record<string, unknown>[] },
  /** A get_settings answer to return verbatim instead of the one built from `reported`. */
  settings?: unknown
) {
  return {
    session: {
      options: new Map<string, string>(listed ? [['model', listed.model]] : []),
      reportedOptions: {} as { model?: string; effort?: string },
      optionMutationSequence: 0,
      reportedModelMutation: 0,
      confirmedOptions: new Set<string>(),
      restoreSkippedOptions: new Set<string>(),
      connection: {
        supportedModels: async () => {
          calls.push('list_models')
          return [...(listed?.catalog ?? [])]
        },
        setModel: async (model: string) => {
          calls.push(`set_model:${model}`)
        },
        applyFlagSettings: async (flags: { effortLevel?: string; ultracode?: boolean }) => {
          // The measured behaviour: an unknown effort is accepted and ignored.
          calls.push(
            `apply:${flags.effortLevel}${flags.ultracode === undefined ? '' : `:ultracode=${flags.ultracode}`}`
          )
        },
        getSettings: async () => {
          calls.push('get_settings')
          if (settings !== undefined) {
            return settings
          }
          return reported === null
            ? { applied: {}, effective: {}, sources: {} }
            : { applied: { effort: reported }, effective: { effortLevel: reported }, sources: {} }
        }
      }
    } as unknown as ClaudeSession,
    calls
  }
}

/** Verbatim from Claude Code 2.1.273's get_settings response, trimmed to the keys read.
 *  The top-level `effective.effortLevel` this lane was written against is GONE; the
 *  effort moved under `modelSettings`, keyed by the resolved id `applied.model` carries
 *  rather than the alias in `effective.model`. */
const REAL_SETTINGS_2_1_273 = {
  applied: { model: 'claude-fable-5-1', effort: 'medium', advisor: null, ultracode: false },
  effective: {
    model: 'fable[1m]',
    modelSettings: {
      'claude-fable-5-1': { effortLevel: 'medium' },
      'claude-sonnet-5': { effortLevel: 'low' }
    },
    env: {}
  },
  sources: {}
}

describe('Claude effort reporting', () => {
  it('reads the effort get_settings reports', () => {
    expect(readClaudeSettingsEffort(REAL_SETTINGS)).toBe('high')
  })

  it('reads the per-model effort a current CLI reports instead of the dropped top-level key', () => {
    // Without this the pill is blank on every host running 2.1.27x or later.
    expect(readClaudeSettingsEffort(REAL_SETTINGS_2_1_273)).toBe('medium')
  })

  it('indexes the per-model block by the resolved id, not the alias the user typed', () => {
    // `effective.model` is "fable[1m]"; keying on it reads nothing and blanks the pill.
    expect(
      readClaudeSettingsEffort({
        ...REAL_SETTINGS_2_1_273,
        effective: {
          ...REAL_SETTINGS_2_1_273.effective,
          modelSettings: { 'fable[1m]': { effortLevel: 'high' } }
        }
      })
    ).toBeNull()
  })

  it('still refuses applied.effort on its own, which is a request and not a measurement', () => {
    expect(
      readClaudeSettingsEffort({
        applied: { model: 'claude-fable-5-1', effort: 'high' },
        effective: { modelSettings: { 'claude-fable-5-1': {} } },
        sources: {}
      })
    ).toBeNull()
  })

  it.each([
    [
      'the provider stops reporting it',
      { applied: { effort: 'high' }, effective: {}, sources: {} }
    ],
    ['the payload carries no effective block', { applied: { effort: 'high' } }],
    ['the request failed outright', null]
  ])('reports no effort when %s', (_case, settings) => {
    // Never defaulted: an effort nothing measured would be worse than a blank
    // pill, and this is the assertion that goes red if the key is renamed.
    expect(readClaudeSettingsEffort(settings)).toBeNull()
  })

  it('publishes the effort from get_settings, which system/init never carries', async () => {
    const claude = fakeClaude({ settings: REAL_SETTINGS })
    const adapter = await acquired(claude)

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { effort: 'high' }
    })
  })

  it('leaves the effort unreported when the session never learns one', async () => {
    const claude = fakeClaude({ settings: { applied: {}, effective: {}, sources: {} } })
    const adapter = await acquired(claude)

    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.effort).toBeUndefined()
    expect(options.current.model).toBeTruthy()
  })

  it('keeps the init fixture free of an effort the real frame never sends', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    await acquired(fakeClaude(), {}, events)
    const init = events.flatMap((event) =>
      event.type === 'message' && event.message.subtype === 'init' ? [event.message] : []
    )

    expect(init).toHaveLength(1)
    expect(init[0]).toHaveProperty('model')
    // The regression that hid this defect: a fixture inventing `effortLevel`
    // kept every gate green over a value that is always empty in production.
    expect(Object.keys(init[0])).not.toContain('effortLevel')
  })
})

describe('Claude effort readback', () => {
  it('records an effort the child did not adopt without vouching for it', async () => {
    const { session, calls } = sessionWith('high')

    // The disagreement stops the confirmation, not the write: no other client
    // vetoes here, and the pre-flight catalog guard already refuses the levels
    // the model cannot run.
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'bogus-effort-xyz' }, undefined)
    ).resolves.toEqual({ effort: 'bogus-effort-xyz' })
    expect(session.confirmedOptions.has('effort')).toBe(false)
    // The child's own answer is kept rather than discarded with the refusal.
    expect(session.reportedOptions.effort).toBe('high')
    expect(calls).toEqual(['apply:bogus-effort-xyz', 'get_settings'])
  })

  it('records an effort the child confirms', async () => {
    const { session } = sessionWith('low')

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    ).resolves.toEqual({ effort: 'low' })
  })

  it('records the request when the readback is unavailable', async () => {
    // No evidence of a refusal is not evidence of one; the apply itself succeeded.
    const { session } = sessionWith(null)

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    ).resolves.toEqual({ effort: 'low' })
  })
})

describe('Claude effort against the model that must run it', () => {
  const HAIKU = { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
  const SONNET = {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  }

  it('refuses an effort the current model advertises no control for', async () => {
    const { session, calls } = sessionWith('high', [], { model: 'haiku', catalog: [HAIKU, SONNET] })

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
    // Measured on Claude Code 2.1.260: apply_flag_settings stores `high` on a
    // haiku session and get_settings reads it straight back, so a send here is
    // never undone. The refusal has to land before the write.
    expect(calls).toEqual(['list_models'])
    expect(session.options.has('effort')).toBe(false)
  })

  it('refuses a level outside the ones the current model advertises', async () => {
    const { session } = sessionWith('high', [], {
      model: 'sonnet',
      catalog: [{ ...SONNET, supportedEffortLevels: ['low', 'medium'] }]
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
  })

  it('sends an effort the current model advertises', async () => {
    const { session, calls } = sessionWith('high', [], {
      model: 'sonnet',
      catalog: [HAIKU, SONNET]
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'high' })
    expect(calls).toEqual(['list_models', 'apply:high', 'get_settings'])
    expect(session.confirmedOptions.has('effort')).toBe(true)
  })

  it('sends `max`, which the readback cannot report, when the model advertises it', async () => {
    // UNREPORTED_EFFORTS still governs: no get_settings, so no false disagreement.
    const { session, calls } = sessionWith('high', [], { model: 'sonnet', catalog: [SONNET] })

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'max' })
    expect(calls).toEqual(['list_models', 'apply:max'])
    expect(session.confirmedOptions.has('effort')).toBe(false)
  })

  it('sends the effort when the model is not in the catalog the CLI listed', async () => {
    // An unlisted model is an unknown one, not one that refuses effort.
    const { session, calls } = sessionWith('high', [], { model: 'sonnet', catalog: [HAIKU] })

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'high' })
    expect(calls).toEqual(['list_models', 'apply:high', 'get_settings'])
  })

  it('sends the effort when list_models is unavailable', async () => {
    const calls: string[] = []
    const { session } = sessionWith('high', calls, { model: 'sonnet', catalog: [] })
    session.connection.supportedModels = async () => {
      calls.push('list_models')
      throw new Error('this CLI predates list_models')
    }

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'high' })
    expect(calls).toEqual(['list_models', 'apply:high', 'get_settings'])
  })

  it('matches the model the init frame reported, not just the id the user picked', async () => {
    const { session } = sessionWith('high', [], { model: 'sonnet', catalog: [HAIKU, SONNET] })
    session.options.delete('model')
    session.reportedOptions.model = 'claude-haiku-4-5-20251001'

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
  })

  it('keeps a disagreeing effort through restore instead of skipping it', async () => {
    const calls: string[] = []
    const { session } = sessionWith('high', calls, { model: 'sonnet', catalog: [SONNET] })
    session.options.set('effort', 'low')

    await restoreClaudeStructuredSessionOptions(session, undefined)

    expect(session.options.get('effort')).toBe('low')
    expect(session.restoreSkippedOptions.has('effort')).toBe(false)
    expect(session.confirmedOptions.has('effort')).toBe(false)
  })

  it('drops a stale effort on restore instead of replaying it onto the new model', async () => {
    const calls: string[] = []
    const { session } = sessionWith('high', calls, { model: 'sonnet', catalog: [HAIKU, SONNET] })
    session.options.set('model', 'haiku')
    session.options.set('effort', 'high')

    await restoreClaudeStructuredSessionOptions(session, undefined)

    expect(session.options.has('effort')).toBe(false)
    expect(session.restoreSkippedOptions.has('effort')).toBe(true)
    expect(calls.filter((call) => call.startsWith('apply:'))).toEqual([])
  })
})

describe('Claude ultracode', () => {
  const SONNET = {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  }
  /** Verbatim shape from Claude Code 2.1.236 under `--effort ultracode`, trimmed to the keys read. */
  const ULTRACODE_SETTINGS = {
    applied: { model: 'claude-fable-5-1', effort: 'xhigh', advisor: null, ultracode: true },
    effective: {
      model: 'claude-fable-5-1[1m]',
      modelSettings: { 'claude-fable-5-1': { effortLevel: 'xhigh' } }
    },
    sources: {}
  }

  it('reads ultracode from the applied flag beside an effective xhigh', () => {
    expect(readClaudeSettingsEffort(ULTRACODE_SETTINGS)).toBe('ultracode')
  })

  it('reads plain xhigh when the flag is off, and never the flag without its level', () => {
    expect(
      readClaudeSettingsEffort({
        ...ULTRACODE_SETTINGS,
        applied: { ...ULTRACODE_SETTINGS.applied, ultracode: false }
      })
    ).toBe('xhigh')
    // The flag beside another effective level is not ultracode running: the ladder
    // level is what the child measured, the flag alone is not.
    expect(
      readClaudeSettingsEffort({
        ...ULTRACODE_SETTINGS,
        effective: { modelSettings: { 'claude-fable-5-1': { effortLevel: 'high' } } }
      })
    ).toBe('high')
    expect(
      readClaudeSettingsEffort({ applied: { ultracode: true }, effective: {}, sources: {} })
    ).toBeNull()
  })

  it('is offered on a model that advertises xhigh and written as xhigh plus the flag', async () => {
    const { session, calls } = sessionWith(
      'high',
      [],
      { model: 'sonnet', catalog: [SONNET] },
      ULTRACODE_SETTINGS
    )

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'ultracode' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'ultracode' })
    expect(calls).toEqual(['list_models', 'apply:xhigh:ultracode=true', 'get_settings'])
    expect(session.confirmedOptions.has('effort')).toBe(true)
  })

  it('is refused on a model that stops below xhigh', async () => {
    const { session, calls } = sessionWith('high', [], {
      model: 'sonnet',
      catalog: [{ ...SONNET, supportedEffortLevels: ['low', 'medium', 'high'] }]
    })

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'ultracode' }, undefined)
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
    expect(calls).toEqual(['list_models'])
  })

  it('clears the flag when leaving ultracode, and sends no flag on a plain change', async () => {
    const { session, calls } = sessionWith('high', [], { model: 'sonnet', catalog: [SONNET] })
    session.options.set('effort', 'ultracode')

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'high' })
    expect(calls).toEqual(['list_models', 'apply:high:ultracode=false', 'get_settings'])

    calls.length = 0
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'low' })
    // A CLI that predates the key refuses the whole write over it, so a plain change
    // must not carry it.
    expect(calls).toEqual(['list_models', 'apply:low', 'get_settings'])
  })

  it('clears the flag on restore when the child reports it is running ultracode', async () => {
    // Acquisition publishes the readback into reportedOptions before restore replays the
    // persisted preference (claude-structured-session-publication.ts), so a session
    // launched with --effort ultracode and a persisted plain level leaves ultracode.
    const { session, calls } = sessionWith('high', [], { model: 'sonnet', catalog: [SONNET] })
    session.reportedOptions.effort = 'ultracode'
    session.options.set('effort', 'high')

    await restoreClaudeStructuredSessionOptions(session, undefined)
    expect(calls).toContain('apply:high:ultracode=false')
    expect(calls).not.toContain('apply:high')
  })

  it('refuses ultracode on a CLI that predates the key, and later plain picks carry no flag', async () => {
    // An older bridge rejects the whole write over an unknown key; nothing is stored,
    // so the next plain pick must not try to clear a flag that was never set.
    const { session, calls } = sessionWith('high', [], { model: 'sonnet', catalog: [SONNET] })
    const connection = session.connection as {
      applyFlagSettings: (flags: { effortLevel?: string; ultracode?: boolean }) => Promise<void>
    }
    connection.applyFlagSettings = async (flags) => {
      if ('ultracode' in flags) {
        throw new ClaudeControlRequestError(
          'apply_flag_settings',
          'only effortLevel can be changed over Remote Control'
        )
      }
      calls.push(`apply:${flags.effortLevel}`)
    }

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'ultracode' }, undefined)
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
    expect(session.options.has('effort')).toBe(false)

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'high' })
    expect(calls.filter((call) => call.startsWith('apply:'))).toEqual(['apply:high'])
  })
})
