vi.mock('./workflow-openrouter-catalog', () => ({
  workflowOpenRouterCatalog: async () => [],
  workflowOpenRouterModels: async () => []
}))
// Never this computer's own Ollama: what is installed here must not decide a test.
vi.mock('./workflow-ollama-catalog', () => ({
  workflowOllamaCatalog: async () => ({
    models: [
      {
        catalog: { id: 'qwen3:8b', label: 'qwen3:8b', isDefault: false, options: [] },
        resolvedModelId: 'qwen3:8b',
        lineage: 'alibaba',
        supportsTools: true
      }
    ]
  }),
  workflowOllamaInstalled: async (model: string) => model === 'qwen3:8b',
  workflowOllamaProfile: async (model: string) => ({
    completion: true,
    tools: model === 'qwen3:8b'
  }),
  workflowOllamaCallContext: () => ({ contextTokens: 8192, maxTokens: 1024, toolTokens: 0 }),
  OLLAMA_NOT_RUNNING: 'Ollama is not running on this computer.'
}))
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import {
  accountEnvironment,
  catalog,
  legacyRouteRevision,
  legacyRouteRevisions,
  preflight,
  routeRevision
} from './local-workflow-provider-catalog'
import {
  assertBinaryVersion,
  grokHome,
  WorkflowCliVersionError
} from './local-workflow-cli-programs'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { freezeWorkflowWorkspaceRoot } from './local-workflow-workspace-root'
import { workflowCatalogModels, workflowCliModel } from './local-workflow-models'
import { localWorkflowRunSpec } from '../../../shared/local-workflow-run-request'
import { resolveLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import { DEFAULT_WORKFLOW_MODEL_TIERS } from '../../../shared/workflow-model-tiers'

const names = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY'
] as const
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = saved[name]
    }
  }
})

const runtime = { getAgentAccountSettings: () => ({}) } as unknown as OrcaRuntimeService

describe('local workflow selected-account environment', () => {
  it('returns model choices that Electron can structured-clone for setup', async () => {
    const seats = await catalog(runtime)
    expect(seats.map((seat) => seat.models[0]?.catalog.id)).toEqual([
      'opus',
      'gpt-5.6-sol',
      'grok-4.6',
      'gemini-3.8-flash',
      undefined,
      'qwen3:8b'
    ])
    const ollama = seats.find((seat) => seat.agent === 'ollama')
    expect(ollama).toMatchObject({
      accountId: 'system:ollama',
      accountLabel: 'Ollama on this computer',
      accountHome: join(homedir(), '.ollama')
    })
    expect(ollama?.policyRevision).toMatch(/^ollama-local-readonly-v1:/)
    expect(() => structuredClone(seats)).not.toThrow()
    const claude = seats.find((seat) => seat.accountId === 'system:claude')
    expect(claude?.accountHome).toBe(join(homedir(), '.claude'))
    // Follow-ups on runs admitted before workspace access still match their route.
    expect(claude?.priorPolicyRevisions).toEqual([
      legacyRouteRevision('claude', join(homedir(), '.claude'))
    ])
    expect(seats.find((seat) => seat.agent === 'gemini')?.priorPolicyRevisions).toBeUndefined()
    expect(() => structuredClone({ catalog: seats })).not.toThrow()
  })

  it('projects the selected named-profile home in the fresh host catalog', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-catalog-profile-'))
    try {
      const configured = {
        getAgentAccountSettings: () => ({
          agentAccountProfiles: [
            { id: 'chosen', agent: 'claude' as const, label: 'Chosen', configDir: home }
          ]
        })
      } as unknown as OrcaRuntimeService
      const seats = await catalog(configured)
      expect(seats.find((seat) => seat.accountId === 'profile:chosen')?.accountHome).toBe(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uses the selected Claude directory without inherited provider credentials', () => {
    for (const name of names) {
      process.env[name] = 'ambient-secret'
    }
    const home = join(homedir(), '.claude')
    const env = accountEnvironment(runtime, {
      id: 'seat-1',
      agent: 'claude',
      accountId: 'system:claude',
      model: 'claude-sonnet-5',
      effort: 'high',
      lineage: 'anthropic',
      policyRevision: routeRevision('claude', home)
    })
    expect(env.CLAUDE_CONFIG_DIR).toBe(home)
    for (const name of names) {
      expect(env[name]).toBeUndefined()
    }
  })

  it('refuses a changed account binding or unsupported model before a provider starts', () => {
    expect(() =>
      accountEnvironment(runtime, {
        id: 'seat-1',
        agent: 'claude',
        accountId: 'system:claude',
        model: 'claude-sonnet-5',
        effort: 'high',
        lineage: 'anthropic',
        policyRevision: 'stale-account-home'
      })
    ).toThrow(/^Claude: the account or model changed/)
  })

  it('refuses a selected account profile whose symlink is retargeted after admission', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-account-binding-'))
    try {
      const first = join(root, 'first')
      const second = join(root, 'second')
      const link = join(root, 'account')
      mkdirSync(first)
      mkdirSync(second)
      symlinkSync(first, link)
      const selected = {
        id: 'seat-1',
        agent: 'claude' as const,
        accountId: 'profile:chosen',
        model: 'claude-sonnet-5',
        effort: 'high',
        lineage: 'anthropic' as const,
        policyRevision: routeRevision('claude', link)
      }
      const configured = {
        getAgentAccountSettings: () => ({
          agentAccountProfiles: [
            {
              id: 'chosen',
              agent: 'claude' as const,
              label: 'Chosen',
              configDir: link
            }
          ]
        })
      } as unknown as OrcaRuntimeService
      expect(accountEnvironment(configured, selected).CLAUDE_CONFIG_DIR).toBe(link)
      rmSync(link)
      symlinkSync(second, link)
      expect(() => accountEnvironment(configured, selected)).toThrow(/account or model changed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('local workflow route models', () => {
  const claudeHome = join(homedir(), '.claude')
  const seat = {
    id: 'seat-1',
    agent: 'claude' as const,
    accountId: 'system:claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    lineage: 'anthropic' as const,
    policyRevision: routeRevision('claude', claudeHome)
  }

  it('offers each route its verified models, defaulting to Opus, Sol, Grok 4.6 and 3.8 Flash', () => {
    const summary = (route: 'claude' | 'codex' | 'grok' | 'gemini') =>
      workflowCatalogModels(route).map((model) => [
        model.catalog.id,
        model.resolvedModelId,
        model.catalog.isDefault,
        model.lineage
      ])
    expect(summary('claude')).toEqual([
      ['opus', 'claude-opus-5-5', true, 'anthropic'],
      ['sonnet', 'claude-sonnet-5-5', false, 'anthropic'],
      ['haiku', 'claude-haiku-4-5-20251001', false, 'anthropic'],
      ['claude-opus-5-5[1m]', 'claude-opus-5-5[1m]', false, 'anthropic'],
      ['claude-haiku-5-5', 'claude-haiku-5-5', false, 'anthropic']
    ])
    expect(summary('codex')).toEqual([
      ['gpt-5.6-sol', 'gpt-5.6-sol', true, 'openai'],
      ['gpt-6-luna', 'gpt-6-luna', false, 'openai'],
      ['gpt-6-astra', 'gpt-6-astra', false, 'openai'],
      ['gpt-5.6-terra', 'gpt-5.6-terra', false, 'openai']
    ])
    const luna = workflowCatalogModels('codex').find(
      (model) => model.resolvedModelId === 'gpt-6-luna'
    )!
    const lunaEffort = luna.catalog.options.find((option) => option.id === 'effort')
    expect(luna.catalog.label).toBe('GPT-6 Luna')
    expect(
      lunaEffort?.kind.type === 'select' && lunaEffort.kind.choices.map(({ value }) => value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(lunaEffort?.kind.type === 'select' && lunaEffort.kind.defaultValue).toBe('high')
    expect(summary('grok')).toEqual([['grok-4.6', 'grok-4.6-build', true, 'xai']])
    expect(summary('gemini')).toEqual([
      ['gemini-3.8-flash', 'gemini-3.8-flash', true, 'google'],
      ['gemini-4-argon', 'gemini-4-argon', false, 'google']
    ])
  })

  it('defaults effort to high, keeps ultracode out and gives Gemini a thinking effort', () => {
    const effort = (route: 'claude' | 'codex' | 'grok' | 'gemini') => {
      const option = workflowCatalogModels(route)[0].catalog.options.find(
        (candidate) => candidate.id === 'effort'
      )
      return option?.kind.type === 'select'
        ? { default: option.kind.defaultValue, choices: option.kind.choices.map((c) => c.value) }
        : undefined
    }
    expect(effort('claude')?.default).toBe('high')
    expect(effort('claude')?.choices).not.toContain('ultracode')
    const longContext = workflowCatalogModels('claude').find(
      (model) => model.resolvedModelId === 'claude-opus-5-5[1m]'
    )!.catalog
    const longEffort = longContext.options.find((candidate) => candidate.id === 'effort')
    expect(longContext.label).toBe('Opus 5.5 (1M context)')
    expect(longEffort?.kind.type === 'select' && longEffort.kind.defaultValue).toBe('high')
    expect(longContext.options.map((option) => option.id)).toEqual(['effort'])
    expect(effort('codex')?.default).toBe('high')
    expect(effort('grok')?.default).toBe('high')
    expect(effort('gemini')).toEqual({ default: 'medium', choices: ['low', 'medium', 'high'] })
    expect(() => structuredClone(workflowCatalogModels('claude'))).not.toThrow()
  })

  it('maps a frozen seat model to the CLI model name', () => {
    expect(workflowCliModel('claude', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    // Retired pins: no longer offered, but a seat frozen with one still runs on it.
    expect(workflowCliModel('claude', 'claude-opus-5')).toBe('claude-opus-5')
    expect(workflowCliModel('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(
      workflowCatalogModels('claude').some(
        ({ resolvedModelId }) => resolvedModelId === 'claude-opus-5'
      )
    ).toBe(false)
    expect(workflowCliModel('claude', 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]')
    expect(workflowCliModel('grok', 'grok-4.6-build')).toBe('grok-4.6')
    expect(workflowCliModel('codex', 'gpt-6-astra')).toBe('gpt-6-astra')
    expect(workflowCliModel('codex', 'gpt-6-luna')).toBe('gpt-6-luna')
    expect(workflowCliModel('gemini', 'gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(() => workflowCliModel('claude', 'claude-haiku-4')).toThrow('not offered')
  })

  it('accepts any listed model and refuses one outside the route list', () => {
    expect(accountEnvironment(runtime, seat).CLAUDE_CONFIG_DIR).toBe(claudeHome)
    const longContext = { ...seat, model: 'claude-opus-5-5[1m]' }
    expect(accountEnvironment(runtime, longContext).CLAUDE_CONFIG_DIR).toBe(claudeHome)
    const frozenBeforeRetirement = { ...seat, model: 'claude-opus-5' }
    expect(accountEnvironment(runtime, frozenBeforeRetirement).CLAUDE_CONFIG_DIR).toBe(claudeHome)
    expect(() => accountEnvironment(runtime, { ...seat, model: 'claude-haiku-4' })).toThrow(
      /account or model changed/
    )
  })

  it('lets only runs admitted before workspace access resume under the legacy policy', () => {
    const legacy = { ...seat, policyRevision: legacyRouteRevision('claude', claudeHome)! }
    expect(legacy.policyRevision).not.toBe(seat.policyRevision)
    expect(accountEnvironment(runtime, legacy).CLAUDE_CONFIG_DIR).toBe(claudeHome)
    expect(() => accountEnvironment(runtime, legacy, 'workspace-read')).toThrow(
      /account or model changed/
    )
    expect(legacyRouteRevision('gemini', join(homedir(), '.gemini'))).toBeUndefined()
  })

  it('keeps the Grok 1.0.40 policy of working-agent release runs for replay and follow-ups', async () => {
    const home = grokHome()
    const pinned = legacyRouteRevisions('grok', home).find((revision) =>
      revision.startsWith('grok-1.0.40-frozen-v1:')
    )
    expect(pinned).toBeDefined()
    expect(legacyRouteRevision('grok', home)?.startsWith('grok-1.0.30-frozen-v1:')).toBe(true)
    const grok = {
      id: 'seat-3',
      agent: 'grok' as const,
      accountId: 'system:grok',
      model: 'grok-4.6-build',
      effort: 'high',
      lineage: 'xai' as const,
      policyRevision: pinned!
    }
    expect(accountEnvironment(runtime, grok).GROK_WORKFLOWS).toBe('0')
    expect(() => accountEnvironment(runtime, grok, 'workspace-read')).toThrow(
      /account or model changed/
    )
    const route = (await catalog(runtime)).find((entry) => entry.agent === 'grok')
    expect(route?.priorPolicyRevisions).toContain(pinned)
  })

  it('injects only the Gemini key, from the selected account, into a Gemini seat', () => {
    for (const name of names) {
      process.env[name] = 'ambient-secret'
    }
    process.env.GEMINI_API_KEY = 'gemini-account-key'
    const env = accountEnvironment(runtime, {
      id: 'seat-4',
      agent: 'gemini',
      accountId: 'system:gemini',
      model: 'gemini-3.8-flash',
      effort: 'medium',
      lineage: 'google',
      policyRevision: routeRevision('gemini', join(homedir(), '.gemini'))
    })
    expect(env.GEMINI_API_KEY).toBe('gemini-account-key')
    for (const name of names.filter((candidate) => candidate !== 'GEMINI_API_KEY')) {
      expect(env[name]).toBeUndefined()
    }
    expect(env.ORCA_PANE_KEY).toBe('')
  })
})

describe('the Haiku 5.5 workflow seat', () => {
  const HAIKU_55 = 'claude-haiku-5-5'

  it('is the Cheap tier Claude with low to high effort, while haiku stays Haiku 4.5', () => {
    const models = workflowCatalogModels('claude')
    const haiku55 = models.find((model) => model.resolvedModelId === HAIKU_55)?.catalog
    expect(haiku55).toMatchObject({
      id: HAIKU_55,
      label: 'Haiku 5.5',
      description: 'Needs Claude Code 2.1.293 or later on the host',
      isDefault: false
    })
    const effort = haiku55?.options.find((option) => option.id === 'effort')
    expect(effort?.kind.type === 'select' && effort.kind.choices.map(({ value }) => value)).toEqual(
      ['low', 'medium', 'high']
    )
    expect(effort?.kind.type === 'select' && effort.kind.defaultValue).toBe('high')
    expect(
      models.filter((model) => model.catalog.isDefault).map(({ catalog }) => catalog.id)
    ).toEqual(['opus'])
    expect(models.find((model) => model.catalog.id === 'haiku')?.resolvedModelId).toBe(
      'claude-haiku-4-5-20251001'
    )
    expect(DEFAULT_WORKFLOW_MODEL_TIERS.cheap[0]).toEqual({ route: 'claude', model: HAIKU_55 })

    const spec = localWorkflowRunSpec(
      { template: 'discover', prompt: 'Find the bugs', models: `find=claude:${HAIKU_55}` },
      ['claude', 'codex']
    )
    expect(spec.steps.find((step) => step.id === 'find')?.agents).toMatchObject([
      { route: 'claude', model: HAIKU_55 }
    ])
    const route = {
      agent: 'claude' as const,
      accountId: 'system:claude',
      accountLabel: 'Claude',
      accountHome: '/home/.claude',
      policyRevision: 'claude-test-v1',
      models
    }
    const choice = { id: 'claude', agent: 'claude' as const, accountId: 'system:claude' }
    expect(resolveLocalWorkflowSeat({ ...choice, model: HAIKU_55 }, [route])).toMatchObject({
      model: HAIKU_55,
      effort: 'high',
      lineage: 'anthropic'
    })
    expect(resolveLocalWorkflowSeat(choice, [route]).model).toBe('claude-opus-5-5')
    expect(workflowCliModel('claude', HAIKU_55)).toBe(HAIKU_55)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses it by name on a Claude CLI older than 2.1.293, keeping the route and Haiku 4.5',
    async () => {
      const savedPath = process.env.PATH
      const bin = mkdtempSync(join(tmpdir(), 'workflow-claude-bin-'))
      const home = mkdtempSync(join(tmpdir(), 'workflow-claude-home-'))
      const cli = (version: string) =>
        writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`, {
          mode: 0o755
        })
      const configured = {
        getAgentAccountSettings: () => ({
          agentAccountProfiles: [
            { id: 'chosen', agent: 'claude' as const, label: 'Chosen', configDir: home }
          ]
        })
      } as unknown as OrcaRuntimeService
      const start = (model: string) =>
        preflight(configured, {
          seats: [
            {
              id: 'seat-1',
              agent: 'claude',
              accountId: 'profile:chosen',
              model,
              effort: null,
              lineage: 'anthropic',
              policyRevision: routeRevision('claude', home)
            }
          ]
        } as unknown as LocalWorkflowHostSnapshot)
      try {
        process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
        cli('2.1.292')
        const refusal =
          'Claude CLI 2.1.293 or newer is required for claude-haiku-5-5; this computer has 2.1.292.'
        await expect(start(HAIKU_55)).rejects.toThrow(refusal)
        // Every launch checks too, with the same refusal.
        const launch = assertBinaryVersion('claude', undefined, undefined, HAIKU_55)
        await expect(launch).rejects.toBeInstanceOf(WorkflowCliVersionError)
        await expect(launch).rejects.toThrow(refusal)
        await expect(start('claude-haiku-4-5-20251001')).resolves.toBeUndefined()
        const seats = await catalog(configured)
        expect(seats.find((seat) => seat.accountId === 'profile:chosen')?.unavailableReason).toBe(
          undefined
        )
        cli('2.1.293')
        await expect(start(HAIKU_55)).resolves.toBeUndefined()
      } finally {
        if (savedPath === undefined) {
          delete process.env.PATH
        } else {
          process.env.PATH = savedPath
        }
        rmSync(bin, { recursive: true, force: true })
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})

describe('local workflow Grok availability and Start checks', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps Grok available to working agents and follow-ups without the streamed login',
    async () => {
      const saved = {
        PATH: process.env.PATH,
        GROK_HOME: process.env.GROK_HOME,
        OMNI_GROK_RUNTIME_SOCKET: process.env.OMNI_GROK_RUNTIME_SOCKET
      }
      // This machine's own runtime socket must not decide the result.
      process.env.OMNI_GROK_RUNTIME_SOCKET = join(tmpdir(), 'workflow-no-runtime-socket')
      const bin = mkdtempSync(join(tmpdir(), 'workflow-grok-bin-'))
      const account = mkdtempSync(join(tmpdir(), 'workflow-grok-home-'))
      const script = '#!/bin/sh\necho "grok 1.0.40 (0123456789ab) [stable]"\n'
      try {
        // A `grok` on PATH (a Homebrew or npm install, or an API-key sign-in without auth.json).
        writeFileSync(join(bin, 'grok'), script, { mode: 0o755 })
        process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ''}`
        process.env.GROK_HOME = account
        const grok = async () => (await catalog(runtime)).find((entry) => entry.agent === 'grok')
        const onPath = await grok()
        expect(onPath?.unavailableReason).toBeUndefined()
        expect(onPath?.streamUnavailableReason).toBe('Grok CLI is not installed.')
        mkdirSync(join(account, 'bin'))
        writeFileSync(join(account, 'bin', 'grok'), script, { mode: 0o755 })
        expect((await grok())?.streamUnavailableReason).toBe(
          'Sign in to Grok (grok login) to use it in workflows.'
        )
        writeFileSync(join(account, 'auth.json'), '{}')
        const signedIn = await grok()
        expect(signedIn?.unavailableReason).toBeUndefined()
        expect(signedIn?.streamUnavailableReason).toBeUndefined()
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[name]
          } else {
            process.env[name] = value
          }
        }
        rmSync(bin, { recursive: true, force: true })
        rmSync(account, { recursive: true, force: true })
      }
    }
  )

  it('refuses at Start to read a workspace that holds the home folder', async () => {
    const snapshot = {
      access: 'workspace-read',
      host: { workspaceRoot: await freezeWorkflowWorkspaceRoot(homedir()) },
      seats: []
    } as unknown as LocalWorkflowHostSnapshot
    await expect(preflight(runtime, snapshot)).rejects.toThrow('it contains your home folder')
  })
})

describe('Grok sandbox availability', () => {
  it('marks Grok unavailable when the runtime socket its sandbox denies is a symlink', async () => {
    const { grokSandboxProblem } = await import('./local-workflow-provider-catalog')
    await expect(
      grokSandboxProblem(async () => ({ isSymbolicLink: () => true }))
    ).resolves.toContain('/var/run/docker.sock is a symlink')
    await expect(
      grokSandboxProblem(async () => ({ isSymbolicLink: () => false }))
    ).resolves.toBeUndefined()
    await expect(
      grokSandboxProblem(async () => {
        throw new Error('ENOENT')
      })
    ).resolves.toBeUndefined()
  })
})
