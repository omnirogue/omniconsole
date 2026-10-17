import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { resolveBackendDraftStartup } from './worktree-draft-startup-view-mode'

type AppState = ReturnType<typeof useAppStore.getState>

const initialSettings = useAppStore.getState().settings!
const initialRepos = useAppStore.getState().repos

const request = {
  repoId: 'repo-1',
  startup: { launchCommand: 'omp' },
  launchDraftPrompt: 'https://github.com/o/r/issues/12'
} as never

function setRepoConnection(connectionId: string | null): void {
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId }]
  } as unknown as Partial<AppState>)
}

function viewModeFor(agent: string): string | undefined {
  const startup = resolveBackendDraftStartup({ ...(request as object), agent } as never) as
    | { viewMode?: string }
    | undefined
  return startup?.viewMode
}

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...initialSettings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
  })
})

afterEach(() => {
  useAppStore.setState({ settings: initialSettings, repos: initialRepos } as Partial<AppState>)
})

describe('resolveBackendDraftStartup', () => {
  it('opens a local omp draft in chat', () => {
    setRepoConnection(null)
    expect(viewModeFor('omp')).toBe('chat')
  })

  it('opens a Model-A SSH omp draft in chat through its relay transcript route', () => {
    setRepoConnection('ssh-target-1')
    expect(viewModeFor('omp')).toBe('chat')
  })

  it('opens a runtime-owned SSH omp draft in chat, which reads the transcript locally', () => {
    setRepoConnection('runtime-ssh-env-1')
    expect(viewModeFor('omp')).toBe('chat')
  })

  it('still requires a locally readable transcript for Grok', () => {
    setRepoConnection(null)
    expect(viewModeFor('grok')).toBe('chat')
    setRepoConnection('ssh-target-1')
    expect(viewModeFor('grok')).toBe('terminal')
  })
})
