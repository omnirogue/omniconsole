import { describe, expect, it } from 'vitest'
import type { AccountCapacityRow } from '../../../../../../shared/provider-account-capacity'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import { LAUNCHER_PROVIDERS, resolveLaunchPlan } from './resolve-launch-plan'

const row = (patch: Partial<AccountCapacityRow> = {}): AccountCapacityRow => ({
  provider: 'claude',
  accountId: 'one',
  choiceId: 'managed:one',
  email: 'one@example.test',
  detail: null,
  isDefault: true,
  isSystem: false,
  fiveHour: null,
  weekly: null,
  fableWeekly: null,
  state: 'ready',
  signedOutReason: null,
  limitedUntil: null,
  readingAt: null,
  readingPausedUntil: null,
  sourceLabel: null,
  launchEnv: { CLAUDE_CONFIG_DIR: '/owned/one' },
  ...patch
})
const base = () => ({
  hasTarget: true,
  local: true,
  defaultProvider: 'claude' as const,
  capabilities: LAUNCHER_PROVIDERS.map((id) => ({
    id,
    label: id,
    status: 'usable',
    models: getAgentSessionOptionCatalog(id)?.models ?? []
  })),
  rows: { claude: [row()], codex: [] }
})

describe('launcher plans', () => {
  it('uses only accounts supplied by the selected paired runtime', () => {
    const account = { ...row(), runtimeEnvironmentId: 'worker' }
    const input = {
      ...base(),
      local: false,
      accountEnvironmentId: 'worker',
      rows: { claude: [account], codex: [] }
    }
    expect(resolveLaunchPlan({ ...input, pick: { account } })).toMatchObject({
      kind: 'launch',
      launchEnv: account.launchEnv
    })
    expect(
      resolveLaunchPlan({ ...input, accountEnvironmentId: 'other', pick: { account } }).kind
    ).toBe('sign-in-required')
    expect(resolveLaunchPlan({ ...input, pick: { account: row() } }).kind).toBe('sign-in-required')
  })
  it('defaults OMP to an attested Kimi route and refuses to inherit the CLI model', () => {
    const input = base()
    const omp = input.capabilities.find((entry) => entry.id === 'omp')!
    const pick = { agent: 'omp' as const }
    expect(resolveLaunchPlan({ ...input, pick }).kind).toBe('model-unavailable')
    omp.models = [
      {
        id: 'openrouter/moonshotai/kimi-k3',
        label: 'Kimi K3',
        options: [],
        openrouterRouting: 'omp-openrouter-routing-v1'
      }
    ]
    expect(resolveLaunchPlan({ ...input, pick })).toEqual({
      kind: 'launch',
      agent: 'omp',
      launchPreferences: { model: 'openrouter/moonshotai/kimi-k3' }
    })
    expect(
      resolveLaunchPlan({ ...input, pick: { ...pick, model: 'openrouter/missing/model' } }).kind
    ).toBe('model-unavailable')
  })

  it('launches a custom preset only through an attested exact OMP route', () => {
    const input = base()
    const omp = input.capabilities.find((entry) => entry.id === 'omp')!
    omp.models = [
      {
        id: 'openrouter/stealth/ox-alpha',
        label: 'Ox Alpha',
        options: [],
        openrouterRouting: 'omp-openrouter-routing-v1'
      }
    ]
    const pick = { customModelId: 'stealth/ox-alpha' }
    expect(resolveLaunchPlan({ ...input, pick })).toEqual({
      kind: 'launch',
      agent: 'omp',
      launchPreferences: { model: 'openrouter/stealth/ox-alpha' }
    })
    omp.models[0] = { ...omp.models[0], openrouterRouting: undefined }
    expect(resolveLaunchPlan({ ...input, pick }).kind).toBe('model-unavailable')
    omp.models = []
    expect(resolveLaunchPlan({ ...input, pick }).kind).toBe('model-unavailable')
    expect(resolveLaunchPlan({ ...input, hasTarget: false, pick }).kind).toBe('target-required')
  })
  it('launches the default account without forcing a catalog model', () => {
    expect(resolveLaunchPlan(base())).toEqual({
      kind: 'launch',
      agent: 'claude',
      launchEnv: { CLAUDE_CONFIG_DIR: '/owned/one' },
      launchPreferences: undefined
    })
  })
  it('uses the first installed provider when the saved provider is unavailable', () => {
    const input = base()
    input.capabilities[0].status = 'cli-missing'
    expect(resolveLaunchPlan(input)).toMatchObject({ kind: 'launch', agent: 'codex' })
  })
  it('falls back from a signed-out default and names the selected row', () => {
    const input = base()
    input.rows.claude = [
      row({ state: 'signed-out', launchEnv: null }),
      row({
        accountId: 'two',
        choiceId: 'managed:two',
        isDefault: false,
        state: 'usable',
        launchEnv: { CLAUDE_CONFIG_DIR: '/owned/two' }
      })
    ]
    expect(resolveLaunchPlan(input)).toMatchObject({
      kind: 'launch',
      launchEnv: { CLAUDE_CONFIG_DIR: '/owned/two' },
      fallbackAccount: { accountId: 'two' }
    })
  })
  it('never substitutes another account for an explicit signed-out pick', () => {
    const input = base()
    input.rows.claude.push(row({ choiceId: 'bad', state: 'signed-out', launchEnv: null }))
    expect(resolveLaunchPlan({ ...input, pick: { account: input.rows.claude[1] } })).toEqual({
      kind: 'sign-in-required'
    })
  })
  it.each(['signed-out'] as const)('refuses %s accounts', (state) => {
    const input = base()
    input.rows.claude = [row({ state })]
    expect(resolveLaunchPlan(input)).toEqual({ kind: 'sign-in-required' })
  })
  it.each(['checking', 'limited'] as const)('keeps the %s default or explicit account', (state) => {
    const input = base()
    input.rows.claude = [row({ state }), row({ choiceId: 'other', isDefault: false })]
    expect(resolveLaunchPlan(input)).toMatchObject({
      kind: 'launch',
      launchEnv: input.rows.claude[0].launchEnv
    })
    expect(resolveLaunchPlan({ ...input, pick: { account: input.rows.claude[0] } })).toMatchObject({
      kind: 'launch'
    })
  })
  it('does not use checking or limited rows for automatic fallback', () => {
    const input = base()
    input.rows.claude = [
      row({ state: 'signed-out' }),
      row({ choiceId: 'other', state: 'limited', isDefault: false })
    ]
    expect(resolveLaunchPlan(input)).toEqual({ kind: 'sign-in-required' })
  })
  it('announces an explicit non-default account', () => {
    const input = base()
    const other = row({ choiceId: 'other', isDefault: false })
    input.rows.claude.push(other)
    expect(resolveLaunchPlan({ ...input, pick: { account: other } })).toMatchObject({
      fallbackAccount: other
    })
  })
  it('allows the legacy path before capacity rows arrive', () => {
    expect(resolveLaunchPlan({ ...base(), rows: { claude: [], codex: [] } })).toEqual({
      kind: 'launch',
      agent: 'claude',
      launchPreferences: undefined
    })
  })
  it('opens a target picker before attempting a launch', () => {
    expect(resolveLaunchPlan({ ...base(), hasTarget: false })).toEqual({ kind: 'target-required' })
  })
  it('never sends client account paths to a remote host', () => {
    expect(resolveLaunchPlan({ ...base(), local: false })).toEqual({
      kind: 'launch',
      agent: 'claude',
      launchPreferences: undefined
    })
  })
  it('validates saved preferences and drops invalid effort independently', () => {
    expect(
      resolveLaunchPlan({ ...base(), defaults: { claude: { model: 'sonnet', effort: 'bogus' } } })
    ).toMatchObject({ launchPreferences: { model: 'sonnet' } })
    expect(
      resolveLaunchPlan({ ...base(), defaults: { claude: { model: 'missing', effort: 'high' } } })
    ).toMatchObject({ launchPreferences: undefined })
  })
  it('an explicit CLI default clears the saved model and effort', () => {
    expect(
      resolveLaunchPlan({
        ...base(),
        defaults: { claude: { model: 'sonnet', effort: 'high' } },
        pick: { model: undefined }
      })
    ).toMatchObject({ launchPreferences: undefined })
  })
  it('retains a valid model/effort pair', () => {
    expect(
      resolveLaunchPlan({ ...base(), defaults: { claude: { model: 'sonnet', effort: 'high' } } })
    ).toMatchObject({ launchPreferences: { model: 'sonnet', effort: 'high' } })
  })
})

it.each(['claude', 'codex'] as const)(
  'launches %s through the host default while the checking default has no launchEnv',
  (agent) => {
    const input = base()
    const placeholder = row({ provider: agent, state: 'checking', launchEnv: null })
    const rows = { ...input.rows, [agent]: [placeholder] }
    expect(resolveLaunchPlan({ ...input, rows, defaultProvider: agent, pick: { agent } })).toEqual({
      kind: 'launch',
      agent,
      launchPreferences: undefined
    })
    expect(resolveLaunchPlan({ ...input, rows, defaultProvider: agent })).toMatchObject({
      kind: 'launch',
      agent
    })
  }
)

it.each(['claude', 'codex'] as const)(
  'launches through the host default when the explicit pick is the checking default row',
  (agent) => {
    const input = base()
    const placeholder = row({ provider: agent, state: 'checking', launchEnv: null })
    const rows = { ...input.rows, [agent]: [placeholder] }
    expect(
      resolveLaunchPlan({
        ...input,
        rows,
        defaultProvider: agent,
        pick: { agent, account: placeholder }
      })
    ).toMatchObject({ kind: 'launch', agent })
  }
)

it.each(['claude', 'codex'] as const)(
  'never silently swaps an explicit checking pick of a non-default row for the host default',
  (agent) => {
    const input = base()
    const defaultRow = row({ provider: agent, state: 'usable' })
    const nonDefaultChecking = row({
      provider: agent,
      choiceId: 'other',
      isDefault: false,
      state: 'checking',
      launchEnv: null
    })
    const rows = { ...input.rows, [agent]: [defaultRow, nonDefaultChecking] }
    expect(
      resolveLaunchPlan({
        ...input,
        rows,
        defaultProvider: agent,
        pick: { agent, account: nonDefaultChecking }
      })
    ).toEqual({ kind: 'sign-in-required' })
  }
)

describe('Gemini launcher plans', () => {
  it.each([true, false])('pins the model without account selection (local: %s)', (local) => {
    expect(resolveLaunchPlan({ ...base(), local, defaultProvider: 'gemini' })).toEqual({
      kind: 'launch',
      agent: 'gemini',
      launchPreferences: { model: 'gemini-3.8-flash' }
    })
  })
  it.each(['disabled', 'cli-missing'])('refuses a %s Gemini CLI', (status) => {
    const input = base()
    input.capabilities.find((entry) => entry.id === 'gemini')!.status = status
    expect(resolveLaunchPlan({ ...input, pick: { agent: 'gemini' } })).toEqual({
      kind: 'provider-unavailable'
    })
  })
  it('preserves saved and explicit older model choices without effort', () => {
    const input = {
      ...base(),
      defaults: { gemini: { model: 'gemini-3.5-flash', effort: 'high' } }
    }
    expect(resolveLaunchPlan({ ...input, pick: { agent: 'gemini' } })).toMatchObject({
      launchPreferences: { model: 'gemini-3.5-flash' }
    })
    expect(
      resolveLaunchPlan({ ...input, pick: { agent: 'gemini', model: 'gemini-3.1-pro-preview' } })
    ).toMatchObject({ launchPreferences: { model: 'gemini-3.1-pro-preview' } })
    expect(
      resolveLaunchPlan({ ...input, pick: { agent: 'gemini', model: undefined } })
    ).toMatchObject({ launchPreferences: { model: 'gemini-3.8-flash' } })
  })
  it('replaces a stale saved model with the catalog default', () => {
    expect(
      resolveLaunchPlan({
        ...base(),
        defaultProvider: 'gemini',
        defaults: { gemini: { model: 'missing' } }
      })
    ).toMatchObject({ launchPreferences: { model: 'gemini-3.8-flash' } })
  })
  it('retires a no-longer-seeded saved model back to the catalog default', () => {
    expect(
      resolveLaunchPlan({
        ...base(),
        defaultProvider: 'gemini',
        defaults: { gemini: { model: 'gemini-2.5-pro' } }
      })
    ).toMatchObject({ launchPreferences: { model: 'gemini-3.8-flash' } })
  })
  it('refuses to silently launch the CLI default if model evidence is empty', () => {
    const input = base()
    input.capabilities.find((entry) => entry.id === 'gemini')!.models = []
    expect(resolveLaunchPlan({ ...input, pick: { agent: 'gemini' } })).toEqual({
      kind: 'provider-unavailable'
    })
  })
})

describe('launcher provider order', () => {
  it('lists Claude, Codex, Kimi, Grok, Muse, OMP, then Gemini', () => {
    expect(LAUNCHER_PROVIDERS).toEqual(['claude', 'codex', 'kimi', 'grok', 'muse', 'omp', 'gemini'])
  })
  it('defaults a plain click to Kimi with its CLI default when it is the first usable provider', () => {
    const input = base()
    for (const entry of input.capabilities) {
      if (entry.id === 'claude' || entry.id === 'codex') {
        entry.status = 'cli-missing'
      }
    }
    expect(resolveLaunchPlan(input)).toEqual({
      kind: 'launch',
      agent: 'kimi',
      launchPreferences: undefined
    })
  })
  it('skips a signed-out Kimi for the next usable provider', () => {
    const input = base()
    for (const entry of input.capabilities) {
      if (entry.id === 'claude' || entry.id === 'codex') {
        entry.status = 'cli-missing'
      } else if (entry.id === 'kimi') {
        entry.status = 'logged-out'
      }
    }
    expect(resolveLaunchPlan(input)).toMatchObject({ kind: 'launch', agent: 'grok' })
  })
})
