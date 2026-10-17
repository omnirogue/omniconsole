import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findAgentTemplate,
  resolveAgentTemplates
} from '../../../../../../../shared/agent-templates'
import { emptyLaunchManifest } from '../../../../../../../shared/launch-manifest'
import { buildOpenCodeLaunchConfig } from '../../../../../../../shared/local-ollama-launch'

type StartResult = { ok: true; tabId: string } | { ok: false; reason: 'failed'; message: string }
type TabResult = { tabId: string; launchCompletion?: Promise<boolean> }
const mocks = vi.hoisted(() => ({
  startCompanySession: vi.fn(async (_args: unknown): Promise<StartResult> => ({
    ok: true,
    tabId: 'tab-1'
  })),
  launchAgentInNewTab: vi.fn((_args: unknown): TabResult => ({ tabId: 'tab-2' })),
  consume: vi.fn(),
  setTabAgentTemplate: vi.fn(),
  claim: { key: 'launch-key', ids: ['instructions:1'] }
}))
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: mocks.startCompanySession,
  createCompanySessionFolder: vi.fn()
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/session-context-store', () => ({
  sessionContextLaunchBinding: () => () => undefined
}))
vi.mock('@/lib/launch-session-context', () => ({
  readLaunchSessionContext: () => ({
    items: [{ id: 'instructions:1', kind: 'instructions', title: 'Once', content: 'Once' }],
    claim: mocks.claim
  }),
  consumeLaunchSessionContext: mocks.consume
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('../launch-context', () => ({
  launchContextKey: () => 'key',
  rememberLaunchContextEntry: async () => undefined
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      setTabAgentTemplate: mocks.setTabAgentTemplate
    })
  }
}))

import { launchLocalOllama } from './launch-local-ollama'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function stubOllama() {
  const prepareLaunch = vi.fn(
    async ({ model, templateId }: { model: string; templateId: string }) => {
      const template = findAgentTemplate(resolveAgentTemplates(undefined), templateId)
      return {
        ok: true as const,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify(
            buildOpenCodeLaunchConfig({
              model,
              template,
              instructionsPaths: [`/template-fixture/${template.id}.md`]
            })
          )
        }
      }
    }
  )
  vi.stubGlobal('window', { api: { localOllama: { prepareLaunch } } })
  return prepareLaunch
}

function preparedConfig(args: Record<string, unknown>): Record<string, unknown> {
  const env = args.launchEnv as { OPENCODE_CONFIG_CONTENT: string }
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT)
}

describe('launchLocalOllama', () => {
  it('records the template at the Work root', async () => {
    const prepareLaunch = stubOllama()
    await expect(
      launchLocalOllama({ templateId: 'developer', model: 'qwen', target: { kind: 'work-root' } })
    ).resolves.toBe(true)
    expect(mocks.startCompanySession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTemplate: { id: 'developer', name: 'Developer', digest: '1f319edbed97' }
      })
    )
    expect(prepareLaunch).toHaveBeenCalledWith({ model: 'qwen', templateId: 'developer' })
    const args = mocks.startCompanySession.mock.calls[0]![0] as Record<string, unknown>
    expect(preparedConfig(args).instructions).toEqual(['/template-fixture/developer.md'])
  })

  it('clears the launcher’s one-shot context once a Work root session has started', async () => {
    stubOllama()
    await expect(
      launchLocalOllama({ templateId: 'developer', model: 'qwen', target: { kind: 'work-root' } })
    ).resolves.toBe(true)
    expect(mocks.startCompanySession).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining('Once') })
    )
    expect(mocks.consume).toHaveBeenCalledWith(mocks.claim)
  })

  it('keeps the launcher’s context when the Work root session does not start', async () => {
    stubOllama()
    mocks.startCompanySession.mockResolvedValueOnce({ ok: false, reason: 'failed', message: 'No' })
    await expect(
      launchLocalOllama({ templateId: 'developer', model: 'qwen', target: { kind: 'work-root' } })
    ).resolves.toBe(false)
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('clears it after a workspace session starts and keeps it when the host refuses', async () => {
    stubOllama()
    const target = { kind: 'workspace' as const, worktreeId: 'wt-1' }
    await expect(
      launchLocalOllama({ templateId: 'developer', model: 'qwen', target })
    ).resolves.toBe(true)
    expect(mocks.consume).toHaveBeenCalledWith(mocks.claim)

    mocks.consume.mockClear()
    mocks.launchAgentInNewTab.mockReturnValueOnce({
      tabId: 'tab-3',
      launchCompletion: Promise.resolve(false)
    })
    await expect(
      launchLocalOllama({ templateId: 'developer', model: 'qwen', target })
    ).resolves.toBe(false)
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('sends exactly the reviewed list with a neutral OpenCode template', async () => {
    const prepareLaunch = stubOllama()
    const manifest = {
      prompt: '',
      project: {
        folderId: 'folder-1',
        name: 'Ads',
        line: 'Project: Ads',
        roster: [],
        pointer: false
      },
      agent: {
        templateId: 'developer',
        name: 'Developer',
        instructions: 'Template text',
        from: 'launcher' as const
      },
      attachments: [
        { id: 'instructions:p', kind: 'instructions' as const, title: 'Rules', content: 'Be brief' }
      ],
      sources: { 'instructions:p': 'project' as const },
      notOnHost: [],
      hostLabel: null,
      folder: { id: 'folder-1', name: 'Ads' }
    }
    await expect(
      launchLocalOllama({
        templateId: 'developer',
        model: 'qwen',
        target: { kind: 'work-root' },
        reviewed: { manifest, removed: ['skill:x'] }
      })
    ).resolves.toBe(true)
    const args = mocks.startCompanySession.mock.calls[0]![0] as Record<string, unknown>
    expect(args.note).toContain('Project: Ads')
    expect(args.note).toContain('Be brief')
    expect(args.note).toContain('Template text')
    expect(prepareLaunch).toHaveBeenCalledWith({ model: 'qwen', templateId: 'default' })
    expect(preparedConfig(args).instructions).toBeUndefined()
    expect(args.note).not.toContain('Once')
    expect(args.sessionContext).toEqual(manifest.attachments)
    expect(args.sessionContextRemoved).toEqual(['skill:x'])
    expect(args.launchManifest).toBe(manifest)
  })

  it.each(['work-root', 'workspace'] as const)(
    'does not inject or record a removed template for a %s launch',
    async (kind) => {
      const prepareLaunch = stubOllama()
      const manifest = emptyLaunchManifest('Only the approved task')
      const target = kind === 'workspace' ? { kind, worktreeId: 'wt-1' } : { kind }
      await expect(
        launchLocalOllama({
          templateId: 'developer',
          model: 'qwen',
          target,
          reviewed: { manifest, removed: [] }
        })
      ).resolves.toBe(true)
      expect(prepareLaunch).toHaveBeenCalledWith({ model: 'qwen', templateId: 'default' })
      const args = (
        kind === 'workspace'
          ? mocks.launchAgentInNewTab.mock.calls[0]![0]
          : mocks.startCompanySession.mock.calls[0]![0]
      ) as Record<string, unknown>
      expect(preparedConfig(args).instructions).toBeUndefined()
      expect(kind === 'workspace' ? args.prompt : args.note).toBe('Only the approved task')
      expect(args.agentTemplate).toBeUndefined()
      if (kind === 'workspace') {
        ;(args.onSessionCreated as (tabId: string) => void)('tab-2')
        expect(mocks.setTabAgentTemplate).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['launcher', 'project'] as const)(
    'delivers and records edited same-ID %s instructions instead of the global template',
    async (from) => {
      const prepareLaunch = stubOllama()
      const instructions = 'Read the approved evidence and do not start another worker.'
      const manifest = {
        ...emptyLaunchManifest(),
        agent: {
          templateId: 'developer',
          name: 'Reviewed developer',
          instructions,
          digest: '000000000000',
          from
        }
      }
      const workspace = from === 'project'
      await expect(
        launchLocalOllama({
          templateId: 'developer',
          model: 'qwen',
          target: workspace ? { kind: 'workspace', worktreeId: 'wt-1' } : { kind: 'work-root' },
          reviewed: { manifest, removed: [] }
        })
      ).resolves.toBe(true)
      expect(prepareLaunch).toHaveBeenCalledWith({ model: 'qwen', templateId: 'default' })
      const args = (
        workspace
          ? mocks.launchAgentInNewTab.mock.calls[0]![0]
          : mocks.startCompanySession.mock.calls[0]![0]
      ) as Record<string, unknown>
      expect(preparedConfig(args).instructions).toBeUndefined()
      expect(workspace ? args.prompt : args.note).toBe(instructions)
      const expected = {
        id: 'developer',
        name: 'Reviewed developer',
        digest: createHash('sha256').update(instructions).digest('hex').slice(0, 12)
      }
      if (workspace) {
        ;(args.onSessionCreated as (tabId: string) => void)('tab-2')
        expect(mocks.setTabAgentTemplate).toHaveBeenCalledWith('tab-2', expected)
      } else {
        expect(args.agentTemplate).toEqual(expected)
      }
    }
  )
})
