import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContextAttachment } from '../../../../../../shared/session-context-attachments'
import { emptyProjectSettings } from '../../../../../../shared/project-settings'
import { LOCAL_OLLAMA_MEMORY_ROOT_KEY } from '../../../../../../shared/local-ollama-launch'

const launchContext = vi.hoisted(() => ({ items: [] as SessionContextAttachment[] }))
const appState = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  repos: [],
  projects: [],
  projectHostSetups: [],
  folderWorkspaceAttachedReposBySource: {},
  sshTargetLabels: new Map()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => appState,
    subscribe: () => () => undefined
  })
}))
vi.mock('@/lib/session-context-store', () => ({
  getSessionContext: () => launchContext.items,
  launchSessionContextKey: () => 'launch-key'
}))

const { withLaunchTemplate, pickFromLaunchManifest, launchManifestFor } =
  await import('./launch-context')
const { launchManifestPrompt } = await import('../../../../../../shared/launch-manifest')
const { useLaunchProject } = await import('@/lib/project-launch')
const { useSessionFolders } = await import('@/store/session-folders')

const ADS = '11111111-1111-4111-8111-111111111111'
const note: SessionContextAttachment = {
  id: 'instructions:1',
  kind: 'instructions',
  title: 'Ship small PRs',
  content: 'Ship small PRs'
}
const file: SessionContextAttachment = {
  id: 'file:local:/repo/README.md',
  kind: 'file',
  title: 'README.md',
  uri: '/repo/README.md',
  hostId: 'local'
}
const own: SessionContextAttachment = {
  id: 'instructions:own',
  kind: 'instructions',
  title: 'Only this launch',
  content: 'Only this launch'
}

beforeEach(() => {
  launchContext.items = [own]
  appState.settings = {}
  useSessionFolders.setState({
    loaded: true,
    metadata: {
      version: 1,
      folders: [{ id: ADS, name: 'Ads' }],
      membership: {},
      projects: {
        [ADS]: {
          ...emptyProjectSettings(1),
          company: 'omnirogue',
          attachments: [note, file],
          agents: [
            {
              templateId: 'reviewer',
              name: 'Reviewer',
              digest: 'a'.repeat(12),
              instructions: 'Review carefully'
            }
          ]
        }
      }
    }
  })
  useLaunchProject.setState({ folderId: null, removed: [], replaced: {} })
})

describe('withLaunchTemplate inside a project', () => {
  it('opens with the project line, the project agent, then everything inherited', () => {
    useLaunchProject.getState().open(ADS)
    const pick = withLaunchTemplate({ opening: undefined }, null, true)
    const prompt = pick.opening?.prompt ?? ''
    expect(prompt.split('\n\n').slice(0, 2)).toEqual([
      'Project: Ads (company omnirogue)',
      'Review carefully'
    ])
    expect(pick.sessionContext?.map((item) => item.id)).toEqual([note.id, file.id, own.id])
    expect(pick.agentTemplate).toEqual({ id: 'reviewer', name: 'Reviewer', digest: 'a'.repeat(12) })
    expect(prompt).toContain('Only this launch')
    // Only the launcher's own items are one-shot; the project's stay with the project.
    expect(pick.launchContextClaim).toEqual({ key: 'launch-key', ids: [own.id] })
  })

  it('leaves an unticked project item out and records it for the session', () => {
    useLaunchProject.getState().open(ADS)
    useLaunchProject.getState().toggleRemoved(note.id)
    const pick = withLaunchTemplate(undefined, null, true)
    expect(pick.sessionContext?.map((item) => item.id)).toEqual([file.id, own.id])
    expect(pick.sessionContextRemoved).toEqual([note.id])
    expect(pick.opening?.prompt).not.toContain('Ship small PRs')
  })

  it('applies the chosen project agent even when its template is not on this computer', () => {
    const project = useSessionFolders.getState().metadata.projects![ADS]!
    project.agents.push({
      templateId: 'project-only',
      name: 'Project specialist',
      digest: 'b'.repeat(12),
      instructions: 'Use the portable specialist instructions'
    })
    appState.settings = {
      launchContextMemory: { [LOCAL_OLLAMA_MEMORY_ROOT_KEY]: { templateId: 'project-only' } }
    }
    useLaunchProject.getState().open(ADS)
    const pick = withLaunchTemplate(undefined, null, true)
    expect(pick.templateId).toBe('project-only')
    expect(pick.opening?.prompt).toContain('Use the portable specialist instructions')
    expect(pick.opening?.prompt).not.toContain('Review carefully')
  })

  it('opens with the project’s default agent when the saved template is gone everywhere', () => {
    appState.settings = {
      launchContextMemory: { [LOCAL_OLLAMA_MEMORY_ROOT_KEY]: { templateId: 'ghost' } }
    }
    useLaunchProject.getState().open(ADS)
    const pick = withLaunchTemplate(undefined, null, true)
    expect(pick.templateId).toBe('reviewer')
    expect(pick.opening?.prompt).toContain('Review carefully')
  })

  it('opens with the template a caller names over the remembered one, as the chat does', () => {
    appState.settings = {
      launchContextMemory: { [LOCAL_OLLAMA_MEMORY_ROOT_KEY]: { templateId: 'developer' } }
    }
    useLaunchProject.getState().open(ADS)
    const manifest = launchManifestFor(undefined, null, false, null, 'coordinator')
    expect(manifest.agent).toMatchObject({ templateId: 'coordinator', from: 'launcher' })
    expect(launchManifestPrompt(manifest)).toContain('# Coordinator')
    expect(launchManifestPrompt(manifest)).not.toContain('Review carefully')
  })

  it('launches as before outside a project', () => {
    const pick = withLaunchTemplate(undefined, null, true)
    expect(pick.opening?.prompt).not.toContain('Project:')
    expect(pick.sessionContext).toEqual([own])
    expect(pick.sessionContextRemoved).toBeUndefined()
    expect(pick.launchContextClaim).toEqual({ key: 'launch-key', ids: [own.id] })
  })

  it('claims nothing when the launcher has no context of its own', () => {
    launchContext.items = []
    const pick = withLaunchTemplate(undefined, null, true)
    expect(pick.sessionContext).toEqual([])
    expect(pick.launchContextClaim).toBeUndefined()
    expect(pick.opening?.prompt ?? '').not.toContain('BEGIN ATTACHED SESSION CONTEXT')
  })
})

it('keeps team instructions in the editable launch list and removes team mode with them', () => {
  const pick = withLaunchTemplate(
    { agent: 'codex', team: true, teamInstructions: 'Use independent Codex subagents.' },
    null,
    true
  )
  expect(pick.team).toBe(true)
  expect(
    pick.launchManifest?.attachments.find((item) => item.id === 'instructions:launch-team')
  ).toMatchObject({ content: 'Use independent Codex subagents.' })
  expect(pick.opening?.prompt).toContain('Use independent Codex subagents.')
  const manifest = pick.launchManifest!
  const withoutTeam = pickFromLaunchManifest(pick, {
    ...manifest,
    attachments: manifest.attachments.filter((item) => item.id !== 'instructions:launch-team')
  })
  expect(withoutTeam.team).toBe(false)
  expect(withoutTeam.opening?.prompt).not.toContain('Use independent Codex subagents.')
})
