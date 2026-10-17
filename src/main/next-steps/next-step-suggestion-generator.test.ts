import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { RemoteCommitMessageExecResult } from '../text-generation/source-control-text-generation-types'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  prepareEnv: vi.fn(),
  getProvider: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ipc/filesystem', () => ({
  resolveModelDiscoveryLocalPath: vi.fn(async (_store: unknown, path: string) => path)
}))
vi.mock('../ipc/local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: vi.fn(() => ({}))
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH is not connected.'
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepareEnv
}))
vi.mock('../text-generation/source-control-agent-launch', () => ({
  spawnSourceControlAgent: mocks.spawn
}))

import {
  generateNextSteps,
  PAIRED_HOST_REASON,
  readNextStepGitFacts,
  resolveNextStepActor,
  type NextStepGeneratorDeps
} from './next-step-suggestion-generator'
import { resolveNextStepWorkspace } from './next-step-workspace'
import type { FinishedTurn } from './next-step-turn-signal'

const REPLY = JSON.stringify({
  suggestions: [
    {
      title: 'Run tests',
      prompt: 'Run the parser tests.',
      why: 'Unverified.',
      risk: 'safe',
      kind: 'verify'
    },
    { title: 'Merge it', prompt: 'Merge the branch.', risk: 'safe', kind: 'ship' }
  ]
})

type Spawned = { binary: string; args: string[]; cwd?: string; stdin: string }

function fakeAgent(stdout: string): Spawned[] {
  const spawned: Spawned[] = []
  mocks.spawn.mockImplementation((input: { binary: string; args: string[]; cwd?: string }) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    const entry: Spawned = { binary: input.binary, args: input.args, cwd: input.cwd, stdin: '' }
    spawned.push(entry)
    child.pid = 4242
    child.kill = vi.fn()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      end: (payload?: string) => {
        entry.stdin = payload ?? ''
        setTimeout(() => {
          ;(child.stdout as EventEmitter).emit('data', Buffer.from(stdout))
          child.emit('exit', 0)
          child.emit('close', 0)
        }, 0)
      }
    }
    return child
  })
  return spawned
}

const store = {
  getRepo: (id: string) =>
    id === 'repo'
      ? { id: 'repo', kind: 'git', connectionId: null }
      : id === 'folderrepo'
        ? { id: 'folderrepo', kind: 'folder' }
        : undefined,
  getFolderWorkspaces: () => [{ id: 'folder:docs', folderPath: '/docs', connectionId: null }],
  getSettings: () => ({ agentCmdOverrides: {} })
} as unknown as NextStepGeneratorDeps['store']

const gitStatus: GitStatusResult = {
  entries: [
    { path: 'src/parser.ts', status: 'modified', area: 'unstaged', added: 12, removed: 3 },
    { path: 'notes.md', status: 'untracked', area: 'untracked' }
  ],
  conflictOperation: 'unknown',
  branch: 'feat/parser',
  upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
}

const deps = (over: Partial<NextStepGeneratorDeps> = {}): NextStepGeneratorDeps => ({
  store,
  settings: () => ({ enabled: true }),
  readGitStatus: vi.fn(async () => gitStatus),
  ...over
})

const turn = (over: Partial<FinishedTurn> = {}): FinishedTurn => ({
  conversation: { worktreeId: 'repo::/work/app', paneKey: 'tab:leaf', kind: 'pty' },
  turnKey: 'tab:leaf@1',
  agent: 'claude',
  lastUserPrompt: 'Fix the parser',
  lastAssistantMessage: 'I fixed the parser in src/parser.ts.',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepareEnv.mockResolvedValue({ ok: true })
})

describe('resolveNextStepWorkspace', () => {
  it('knows git worktrees, folder projects and folder workspaces, and nothing else', () => {
    expect(resolveNextStepWorkspace(store, 'repo::/work/app')).toEqual({
      path: '/work/app',
      git: true
    })
    expect(resolveNextStepWorkspace(store, 'folderrepo::/notes')).toMatchObject({ git: false })
    expect(resolveNextStepWorkspace(store, 'folder:docs')).toEqual({ path: '/docs', git: false })
    expect(resolveNextStepWorkspace(store, 'paired::/elsewhere')).toBeNull()
  })
})

describe('readNextStepGitFacts', () => {
  it('reports branch, upstream, the change count and per-path line counts', async () => {
    expect(await readNextStepGitFacts(async () => gitStatus, 'repo::/w')).toEqual({
      branch: 'feat/parser',
      upstream: { ahead: 2, behind: 0 },
      changedFiles: 2,
      diffStat: 'modified src/parser.ts | +12 -3\nuntracked notes.md\n'
    })
    expect(
      await readNextStepGitFacts(async () => {
        throw new Error('git missing')
      }, 'repo::/w')
    ).toEqual({ unavailable: true })
  })
})

describe('resolveNextStepActor', () => {
  it('uses the conversation’s own agent unless settings choose one', () => {
    expect(resolveNextStepActor({ enabled: true }, 'codex')).toMatchObject({ agent: 'codex' })
    expect(
      resolveNextStepActor({ enabled: true, agent: 'claude', model: 'opus' }, 'codex')
    ).toEqual({ agent: 'claude', model: 'opus' })
    expect(resolveNextStepActor({ enabled: true }, 'mystery-agent')).toMatchObject({
      error: expect.stringMatching(/cannot suggest next steps/)
    })
  })

  it('lets Claude write suggestions for an agent with no one-shot runner', () => {
    expect(resolveNextStepActor({ enabled: true }, 'grok')).toMatchObject({ agent: 'claude' })
    // A setting that names an agent with no runner still says so.
    expect(resolveNextStepActor({ enabled: true, agent: 'grok' }, 'codex')).toMatchObject({
      error: expect.stringMatching(/cannot suggest next steps/)
    })
  })
})

describe('generateNextSteps', () => {
  it('runs Claude read-only in plan mode with the bounded prompt and parses the reply', async () => {
    const spawned = fakeAgent(REPLY)
    const result = await generateNextSteps(deps(), turn(), new AbortController().signal)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) {
      return
    }
    expect(result.suggestions.map((s) => [s.id, s.risk])).toEqual([
      ['s1', 'safe'],
      ['s2', 'risky']
    ])
    expect(spawned).toHaveLength(1)
    const [call] = spawned
    expect(call!.binary).toBe('claude')
    expect(call!.args).toEqual(expect.arrayContaining(['-p', '--permission-mode', 'plan']))
    expect(call!.cwd).toBe('/work/app')
    const prompt = call!.stdin || call!.args.join(' ')
    expect(prompt).toContain('Fix the parser')
    expect(prompt).toContain('Branch: feat/parser')
    expect(prompt).toContain('modified src/parser.ts | +12 -3')
  })

  it('tells the suggester the conversation’s goal and keeps at most three steps', async () => {
    const many = JSON.stringify({
      suggestions: ['One', 'Two', 'Three', 'Four', 'Five'].map((title) => ({
        title,
        prompt: `Do ${title}.`,
        risk: 'safe',
        kind: 'continue'
      }))
    })
    const spawned = fakeAgent(many)
    const result = await generateNextSteps(deps(), turn(), new AbortController().signal, {
      goal: 'Ship the parser rewrite',
      proposedSteps: ['Merge the PR']
    })
    expect(result.ok && result.suggestions.map((s) => s.title)).toEqual(['One', 'Two', 'Three'])
    const prompt = spawned[0]!.stdin || spawned[0]!.args.join(' ')
    expect(prompt).toContain('Ship the parser rewrite')
    expect(prompt).toContain('- Merge the PR')
  })

  it('runs Codex through exec --ephemeral in the read-only sandbox', async () => {
    const spawned = fakeAgent(REPLY)
    const result = await generateNextSteps(
      deps(),
      turn({ agent: 'codex' }),
      new AbortController().signal
    )
    expect(result).toMatchObject({ ok: true })
    expect(spawned[0]!.binary).toBe('codex')
    expect(spawned[0]!.args).toEqual(
      expect.arrayContaining(['exec', '--ephemeral', '-s', 'read-only'])
    )
  })

  it('skips git facts for a folder workspace', async () => {
    const spawned = fakeAgent(REPLY)
    const readGitStatus = vi.fn(async () => gitStatus)
    await generateNextSteps(
      deps({ readGitStatus }),
      turn({ conversation: { worktreeId: 'folder:docs', paneKey: 'tab:leaf', kind: 'pty' } }),
      new AbortController().signal
    )
    expect(readGitStatus).not.toHaveBeenCalled()
    expect(spawned[0]!.stdin || spawned[0]!.args.join(' ')).not.toContain('Branch:')
  })

  it('fails in plain words on a paired-host workspace or an unusable reply', async () => {
    fakeAgent('no json here')
    expect(
      await generateNextSteps(
        deps(),
        turn({ conversation: { worktreeId: 'paired::/x', paneKey: 'p', kind: 'pty' } }),
        new AbortController().signal
      )
    ).toEqual({ ok: false, error: PAIRED_HOST_REASON })
    expect(await generateNextSteps(deps(), turn(), new AbortController().signal)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/did not answer/)
    })
  })

  it('runs on the SSH host and cancels there through its own operation lane', async () => {
    const executeCommitMessagePlan = vi.fn(async (): Promise<RemoteCommitMessageExecResult> => ({
      stdout: REPLY,
      stderr: '',
      exitCode: 0,
      timedOut: false
    }))
    const cancelNonInteractiveExec = vi.fn(async () => {})
    mocks.getProvider.mockReturnValue({ executeCommitMessagePlan, cancelNonInteractiveExec })
    const sshStore = {
      ...store,
      getRepo: () => ({ id: 'repo', kind: 'git', connectionId: 'ssh-1' })
    } as unknown as NextStepGeneratorDeps['store']
    const controller = new AbortController()
    const result = await generateNextSteps(deps({ store: sshStore }), turn(), controller.signal)
    expect(result).toMatchObject({ ok: true })
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      expect.objectContaining({ binary: 'claude' }),
      '/work/app',
      90_000,
      'next-step-suggestions'
    )

    // The remote call only returns once the host cancels it.
    executeCommitMessagePlan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          cancelNonInteractiveExec.mockImplementationOnce(async () => {
            resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, canceled: true })
          })
        })
    )
    const aborting = new AbortController()
    const pending = generateNextSteps(deps({ store: sshStore }), turn(), aborting.signal)
    await vi.waitFor(() => expect(executeCommitMessagePlan).toHaveBeenCalledTimes(2))
    aborting.abort('superseded')
    expect(await pending).toMatchObject({ ok: false, error: 'Generation canceled.' })
    expect(cancelNonInteractiveExec).toHaveBeenCalledWith('/work/app', 'next-step-suggestions')
  })

  it('tells the model git facts could not be read when the status read fails', async () => {
    const spawned = fakeAgent(REPLY)
    await generateNextSteps(
      deps({
        readGitStatus: vi.fn(async (): Promise<GitStatusResult> => {
          throw new Error('git missing')
        })
      }),
      turn(),
      new AbortController().signal
    )
    expect(spawned[0]!.stdin || spawned[0]!.args.join(' ')).toContain('Git facts could not be read')
  })

  it('aborting one call never cancels another call running in the same workspace', async () => {
    const children: (EventEmitter & Record<string, unknown>)[] = []
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      child.pid = 5000 + children.length
      child.kill = vi.fn()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end: () => {} }
      children.push(child)
      return child
    })
    const a = new AbortController()
    const b = new AbortController()
    const first = generateNextSteps(deps(), turn({ turnKey: 'a' }), a.signal)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const second = generateNextSteps(deps(), turn({ turnKey: 'b' }), b.signal)
    await vi.waitFor(() => expect(children).toHaveLength(2))
    a.abort('superseded')
    expect(children[1]!.kill).not.toHaveBeenCalled()
    b.abort('pane-closed')
    expect(children[1]!.kill).toHaveBeenCalled()
    expect(await second).toMatchObject({ ok: false, error: 'Generation canceled.' })
    children[0]!.emit('close', 1)
    await first
  })
})
