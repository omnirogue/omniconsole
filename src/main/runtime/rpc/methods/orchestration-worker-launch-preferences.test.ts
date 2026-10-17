import { describe, expect, it } from 'vitest'
import { routineLaunchArgs } from '../../../../shared/automation-tool-launch'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  createWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './orchestration-worker-launch-preferences'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import { validateFederatedWorkerStartPlacement } from './orchestration-worker-start-validation'

describe('orchestration worker launch preferences', () => {
  it('pins writable launch permission even when the global default is Plan mode', () => {
    for (const [agent, defaultArgs, writableArg] of [
      ['claude', '--permission-mode plan', '--dangerously-skip-permissions'],
      ['codex', '-s read-only -a never', '--dangerously-bypass-approvals-and-sandbox'],
      ['grok', '--permission-mode plan', '--permission-mode bypassPermissions']
    ] as const) {
      const launch = resolveWorkerLaunchPreferences({ agent, permissionMode: 'yolo' })
      expect(launch.preferences).toEqual({ permissionMode: 'yolo' })
      expect(launch.receipt.effective).toMatchObject({ agent, permissionMode: 'yolo' })
      const args = routineLaunchArgs(agent, defaultArgs, launch.preferences)
      expect(args).toContain(writableArg)
      expect(args).not.toContain('plan')
      expect(args).not.toContain('read-only')
    }
  })

  it('rejects explicit permission for agents whose launch flags are not verified', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'opencode', permissionMode: 'yolo' })
    ).toThrow('unsupported for opencode')
  })

  it('rejects a permission override when reusing a terminal', () => {
    expect(() =>
      assertWorkerLaunchPreferencesCreateTerminal({
        terminal: 'term_existing',
        permissionMode: 'yolo'
      })
    ).toThrow('cannot be applied when reusing an existing terminal')
  })

  it('rejects unknown permission modes before worker effects', () => {
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        from: 'term_coord',
        worktree: 'new-child',
        name: 'child',
        agent: 'codex',
        permissionMode: 'plan'
      }).success
    ).toBe(false)
  })

  it('refuses an explicit permission mode on a remote worker before effects', () => {
    const params = WorkerStartParams.parse({
      task: 'task_1',
      from: 'term_coord',
      worktree: 'new-top-level',
      repo: 'repo_1',
      name: 'worker',
      agent: 'codex',
      permissionMode: 'yolo'
    })
    expect(() => validateFederatedWorkerStartPlacement(params, true)).toThrow(
      'requires a local worker'
    )
  })

  it('passes an opaque Claude model and portable effort through the shared catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high'
      })
    ).toEqual({
      preferences: { model: 'aws-bedrock-opus-5', effort: 'high' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        effective: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        effectiveSource: 'resolved-launch-arguments'
      }
    })
  })

  it('does not invent an effort when only a model is requested', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'codex', model: 'gpt-5.6-sol' }).preferences
    ).toEqual({ model: 'gpt-5.6-sol' })
  })

  it.each([
    {
      model: 'gpt-5.6-sol',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.6-terra',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.6-luna',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      rejected: ['ultra', 'future-effort']
    },
    {
      model: 'gpt-5.5',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.2-codex',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.4',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.4-mini',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.3-codex-spark',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'future-codex-model',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    }
  ])('enforces the Codex effort ceiling for $model', ({ model, accepted, rejected }) => {
    const catalog = getAgentSessionOptionCatalog('codex')!
    const effort =
      catalog.models
        .find((candidate) => candidate.id === model)
        ?.options.find((option) => option.id === 'effort') ??
      catalog.unknownModelOptions?.find((option) => option.id === 'effort')

    expect(effort?.kind.type).toBe('select')
    expect(
      effort?.kind.type === 'select' ? effort.kind.choices.map(({ value }) => value) : []
    ).toEqual(accepted)

    for (const effortValue of accepted) {
      expect(
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue }).preferences
      ).toEqual({ model, effort: effortValue })
    }
    for (const effortValue of rejected) {
      expect(() =>
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue })
      ).toThrow(`does not support effort ${effortValue}`)
    }
  })

  it.each(['low', 'high'])('rejects explicit worker effort %s without a model', (effort) => {
    expect(() => resolveWorkerLaunchPreferences({ agent: 'codex', effort })).toThrow(
      '--effort requires --model'
    )
  })

  it('rejects model selection for agents without a launch catalog', () => {
    expect(() => resolveWorkerLaunchPreferences({ agent: 'aider', model: 'gpt-5.5' })).toThrow(
      'does not support launch-time model selection'
    )
  })

  it('accepts a provider/model id for opencode, whose models come from its config', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'opencode', model: 'ollama/qwen3-coder:30b' })
    ).toMatchObject({ preferences: { model: 'ollama/qwen3-coder:30b' } })
  })

  it('accepts grok model and effort selection through its launch catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'grok', model: 'grok-4.6', effort: 'xhigh' })
    ).toMatchObject({
      preferences: { model: 'grok-4.6', effort: 'xhigh' },
      receipt: { effective: { agent: 'grok', model: 'grok-4.6', effort: 'xhigh' } }
    })
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'grok', model: 'grok-4.5', effort: 'xhigh' })
    ).toThrow('does not support effort xhigh')
  })

  it('accepts Gemini model selection through its launch catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'gemini', model: 'gemini-3.8-flash' })
    ).toMatchObject({
      preferences: { model: 'gemini-3.8-flash' },
      receipt: { effective: { agent: 'gemini', model: 'gemini-3.8-flash' } }
    })
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'gemini',
        model: 'gemini-3.8-flash',
        effort: 'high'
      })
    ).toThrow('Agent gemini model gemini-3.8-flash does not support effort high.')
    // Why: the shared check has no catalog-membership gate for a model id — only the
    // + launcher's resolveLaunchPlan enforces that. A retired id like the old seed's
    // gemini-3-pro-preview is still accepted here; it is passed straight through to -m.
    expect(
      resolveWorkerLaunchPreferences({ agent: 'gemini', model: 'gemini-3-pro-preview' })
    ).toMatchObject({
      preferences: { model: 'gemini-3-pro-preview' },
      receipt: { effective: { agent: 'gemini', model: 'gemini-3-pro-preview' } }
    })
  })

  it('rejects preferences when reusing an existing terminal', () => {
    expect(() =>
      assertWorkerLaunchPreferencesCreateTerminal({
        terminal: 'term_existing',
        model: 'gpt-5.6-sol'
      })
    ).toThrow('cannot be applied when reusing an existing terminal')
  })

  it('requires remote capability support only for explicit preferences', () => {
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        model: 'gpt-5.6-sol',
        capabilities: [],
        serverName: 'windows'
      })
    ).toThrow('does not support worker model or effort overrides')
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        capabilities: [],
        serverName: 'windows'
      })
    ).not.toThrow()
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        model: 'gpt-5.6-sol',
        capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY],
        serverName: 'windows'
      })
    ).not.toThrow()
  })

  it('uses the requested launch receipt when an older worker omits it', () => {
    const requested = createPendingWorkerLaunchReceipt({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high'
    })

    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, true)).toEqual({
      requested: requested.requested,
      effective: requested.requested,
      effectiveSource: 'legacy-acknowledgement'
    })
    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, false)).toBe(requested)
  })

  it.each([' custom-model', 'custom-model '])(
    'rejects model ids with surrounding whitespace: %j',
    (model) => {
      expect(WorkerStartParams.safeParse({ task: 'task_1', agent: 'codex', model }).success).toBe(
        false
      )
    }
  )

  it('bounds opaque launch preferences', () => {
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        agent: 'codex',
        model: 'm'.repeat(513)
      }).success
    ).toBe(false)
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        agent: 'codex',
        model: 'custom-model',
        effort: 'e'.repeat(513)
      }).success
    ).toBe(false)
  })
})

it('requires OMP route capability and refuses stripped or reordered launch receipts', () => {
  const route = {
    agent: 'omp' as const,
    model: 'openrouter/x-ai/grok-4',
    openrouterCandidates: ['x-ai/grok-4', 'google/gemini-3']
  }
  const receipt = createWorkerLaunchReceipt(route)
  expect(() =>
    assertWorkerLaunchPreferencesRuntimeSupported({
      ...route,
      capabilities: ['orchestration.worker-launch-preferences.v1'],
      serverName: 'old'
    })
  ).toThrow()
  expect(() =>
    assertWorkerLaunchPreferencesRuntimeSupported({
      ...route,
      capabilities: ['orchestration.worker-launch-preferences.v1', 'omp-openrouter-routing-v1'],
      serverName: 'new'
    })
  ).not.toThrow()
  expect(() => resolveFederatedWorkerLaunchReceipt(undefined, receipt, true)).toThrow()
  expect(() =>
    resolveFederatedWorkerLaunchReceipt(
      { ...receipt, requested: { ...receipt.requested, openrouterCandidates: undefined } },
      receipt,
      true
    )
  ).toThrow()
  expect(() =>
    resolveFederatedWorkerLaunchReceipt(
      {
        ...receipt,
        effective: {
          ...receipt.requested,
          openrouterCandidates: route.openrouterCandidates.toReversed()
        }
      },
      receipt,
      true
    )
  ).toThrow()
  expect(resolveFederatedWorkerLaunchReceipt(receipt, receipt, true)).toEqual(receipt)
})
