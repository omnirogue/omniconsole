import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_ISOLATED_HEADLESS_ARGS } from '../../shared/claude-isolated-headless'
import {
  createModelDiscoveryCache,
  installLocalModelDiscoveryCache,
  MODEL_DISCOVERY_CACHE_TTL_MS,
  MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS
} from './model-discovery-cache'
import { SSH_MUX_REQUEST_TIMEOUT_CODE } from '../ssh/ssh-channel-multiplexer'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote
} from './commit-message-text-generation'
import {
  createChildTerminationExpectation,
  createMockDiscoveryChild,
  withPlatform
} from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

const expectChildTerminated = createChildTerminationExpectation(terminateWindowsProcessTreeMock)

beforeEach(() => {
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('discoverCommitMessageModelsLocal', () => {
  it('cleans up child listeners when a non-Codex discovery starts already aborted', async () => {
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)
    const controller = new AbortController()
    controller.abort()
    await expect(
      discoverCommitMessageModelsLocal('claude', undefined, undefined, {
        signal: controller.signal
      })
    ).resolves.toMatchObject({ success: false, error: 'Model discovery canceled.' })
    expectChildTerminated(child)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    child.emit('close', null, 'SIGKILL')
  })
  it('cancels already-aborted and queued Codex discovery without spawning a late child', async () => {
    const aborted = new AbortController()
    aborted.abort(new Error('already canceled'))
    await expect(
      discoverCommitMessageModelsLocal(
        'codex',
        { CODEX_HOME: '/managed/already-aborted' },
        undefined,
        { signal: aborted.signal }
      )
    ).rejects.toThrow('already canceled')
    expect(spawnMock).not.toHaveBeenCalled()
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)
    const active = new AbortController()
    const env = { CODEX_HOME: '/managed/queued-cancel-home' }
    const first = discoverCommitMessageModelsLocal('codex', env, undefined, {
      signal: active.signal
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    const queued = new AbortController()
    const second = discoverCommitMessageModelsLocal('codex', env, undefined, {
      signal: queued.signal
    })
    queued.abort(new Error('queued canceled'))
    await expect(second).rejects.toThrow('queued canceled')
    active.abort()
    await expect(first).resolves.toMatchObject({
      success: false,
      error: 'Model discovery canceled.'
    })
    expectChildTerminated(child)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    child.emit('exit', null, 'SIGKILL')
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('returns static catalog models without spawning for static agents', async () => {
    const result = await discoverCommitMessageModelsLocal('amp', undefined)

    expect(result).toMatchObject({
      success: true,
      catalogOrigin: 'spec',
      defaultModelId: 'smart'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('discovers dynamic models through the agent CLI', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined)

    listeners.get('stdout:data')?.(Buffer.from('auto - Auto\ngpt-5.2 - GPT-5.2\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'auto',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'gpt-5.2', label: 'GPT-5.2' }
      ]
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'cursor-agent',
      ['--list-models'],
      expect.objectContaining({ windowsHide: true })
    )
  })

  it('writes the Claude list_models request to stdin and parses the control response', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { on: vi.fn(), end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('claude', undefined)

    listeners.get('stdout:data')?.(
      Buffer.from(
        `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'omni-model-discovery',
            response: {
              models: [
                { value: 'default', displayName: 'Default (recommended)' },
                {
                  value: 'opus[1m]',
                  displayName: 'Opus (1M context)',
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
                },
                { value: 'sonnet', displayName: 'Sonnet' },
                { value: 'haiku', displayName: 'Haiku' }
              ]
            }
          }
        })}\n`
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      catalogOrigin: 'probe',
      defaultModelId: 'sonnet',
      models: [
        { id: 'opus[1m]', label: 'Opus (1M context)' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' }
      ]
    })
    // Quiet background runs (default on): the listing runs with the isolated recipe, so none of
    // the person's hooks, MCP servers or settings files load for it.
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        ...CLAUDE_ISOLATED_HEADLESS_ARGS
      ],
      expect.objectContaining({
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
      })
    )
    expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining('"list_models"'))
  })

  it('answers a repeat listing from the installed cache until the CLI binary changes', async () => {
    let binary = 'claude:1'
    installLocalModelDiscoveryCache(createModelDiscoveryCache({ fingerprint: async () => binary }))
    const listen = () => {
      const listeners = new Map<string, (value: unknown) => void>()
      spawnMock.mockReturnValueOnce({
        pid: 123,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { on: vi.fn(), end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      } as never)
      return listeners
    }
    const answer = async (listeners: Map<string, (value: unknown) => void>) => {
      await vi.waitFor(() => expect(listeners.get('close')).toBeDefined())
      listeners.get('stdout:data')?.(
        Buffer.from(
          '{"type":"control_response","response":{"subtype":"success","request_id":"omni-model-discovery","response":{"models":[{"value":"sonnet","displayName":"Sonnet"}]}}}\n'
        )
      )
      listeners.get('close')?.(0)
    }
    try {
      const first = listen()
      const pending = discoverCommitMessageModelsLocal('claude', { PATH: '/bin' })
      await answer(first)
      await expect(pending).resolves.toMatchObject({ success: true, catalogOrigin: 'probe' })
      await expect(
        discoverCommitMessageModelsLocal('claude', { PATH: '/bin' })
      ).resolves.toMatchObject({ success: true, models: [{ id: 'sonnet' }] })
      expect(spawnMock).toHaveBeenCalledTimes(1)

      binary = 'claude:2'
      const second = listen()
      const updated = discoverCommitMessageModelsLocal('claude', { PATH: '/bin' })
      await answer(second)
      await expect(updated).resolves.toMatchObject({ success: true })
      expect(spawnMock).toHaveBeenCalledTimes(2)
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })

  it('an explicit refresh starts a listing again that the installed cache holds as failed', async () => {
    installLocalModelDiscoveryCache(
      createModelDiscoveryCache({ fingerprint: async () => 'claude:1' })
    )
    const original = spawnMock.getMockImplementation()
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EAGAIN')
    })
    try {
      const discover = (force?: boolean) =>
        discoverCommitMessageModelsLocal('claude', { PATH: '/bin' }, undefined, { force })
      await expect(discover()).resolves.toMatchObject({ success: false })
      await expect(discover()).resolves.toMatchObject({ success: false })
      expect(spawnMock).toHaveBeenCalledTimes(1)
      await discover(true)
      expect(spawnMock).toHaveBeenCalledTimes(2)
    } finally {
      installLocalModelDiscoveryCache(null)
      spawnMock.mockImplementation(original!)
    }
  })

  it('falls back to the Claude seed models when the CLI lacks list_models', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { on: vi.fn(), end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('claude', undefined)

    // Captured from claude 2.1.100: the unsupported subtype still exits 0.
    listeners.get('stdout:data')?.(
      Buffer.from(
        '{"type":"control_response","response":{"subtype":"error","request_id":"omni-model-discovery","error":"Unsupported control request subtype: list_models"}}\n'
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      catalogOrigin: 'spec',
      defaultModelId: 'sonnet',
      models: [{ id: 'haiku' }, { id: 'sonnet' }, { id: 'opus' }]
    })
  })

  it('discovers dynamic models through the configured agent command override', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined, 'npx cursor-agent')

    listeners.get('stdout:data')?.(Buffer.from('auto - Auto\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'auto'
    })
    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        ['/d', '/c', expect.stringMatching(/npx\.cmd$/i), 'cursor-agent', '--list-models'],
        expect.objectContaining({ windowsHide: true })
      )
    } else {
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['cursor-agent', '--list-models'],
        expect.objectContaining({ windowsHide: true })
      )
    }
  })

  it('discovers dynamic models through the selected WSL distro login shell', async () => {
    await withPlatform('win32', async () => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      spawnMock.mockReturnValue(child as never)

      const pending = discoverCommitMessageModelsLocal('cursor', undefined, undefined, {
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu'
      })

      listeners.get('stdout:data')?.(Buffer.from('auto - Auto\n'))
      listeners.get('close')?.(0)

      await expect(pending).resolves.toMatchObject({
        success: true,
        defaultModelId: 'auto'
      })
      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--exec', 'sh', '-lc', expect.any(String)],
        expect.objectContaining({
          cwd: undefined,
          windowsHide: true
        })
      )
      const shellCommand = spawnMock.mock.calls[0]?.[1]?.[5] as string
      expect(shellCommand).toContain('getent passwd')
      expect(shellCommand).toContain('/mnt/c/repo')
      expect(shellCommand).toContain("'cursor-agent'")
      expect(shellCommand).toContain('--list-models')
    })
  })

  it('falls back to static models when dynamic discovery returns no parseable models', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('pi', undefined)

    listeners.get('stdout:data')?.(Buffer.from('provider model\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'github-copilot/gpt-5.4-mini',
      models: [{ id: 'github-copilot/gpt-5.4-mini' }]
    })
  })

  it('parses Pi model discovery from stderr when the CLI exits successfully', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('pi', undefined)

    listeners.get('stderr:data')?.(
      Buffer.from(
        [
          'provider        model                   context  max-out  thinking  images',
          'github-copilot  gpt-5.4-mini            400K     128K     yes       yes',
          'openai-codex    gpt-5.5                 272K     128K     yes       yes'
        ].join('\n')
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'github-copilot/gpt-5.4-mini',
      models: [{ id: 'github-copilot/gpt-5.4-mini' }, { id: 'openai-codex/gpt-5.5' }]
    })
  })

  it('settles and detaches model discovery when timeout kill is ignored', async () => {
    vi.useFakeTimers()
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)

    try {
      const pending = discoverCommitMessageModelsLocal('cursor', undefined)
      const assertion = expect(pending).resolves.toMatchObject({
        success: false,
        error: 'Cursor model discovery timed out after 60s.'
      })

      await vi.advanceTimersByTimeAsync(60_000)

      await assertion
      expectChildTerminated(child)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the Codex home locked after a discovery timeout until the child closes', async () => {
    vi.useFakeTimers()
    const firstChild = createMockDiscoveryChild()
    const secondChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const env = { CODEX_HOME: '/managed/codex-discovery-home' }

    try {
      const first = discoverCommitMessageModelsLocal('codex', env)
      await vi.advanceTimersByTimeAsync(0)
      const second = discoverCommitMessageModelsLocal('codex', env)
      await vi.advanceTimersByTimeAsync(60_000)

      await expect(first).resolves.toMatchObject({
        success: false,
        error: 'Codex model discovery timed out after 60s.'
      })
      expectChildTerminated(firstChild)
      expect(spawnMock).toHaveBeenCalledTimes(1)

      firstChild.emit('close', null)
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnMock).toHaveBeenCalledTimes(2)
      secondChild.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] }))
      )
      secondChild.emit('close', 0)
      await expect(second).resolves.toMatchObject({ success: true, defaultModelId: 'gpt-5.5' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the Codex home after a discovery timeout once the child exits', async () => {
    vi.useFakeTimers()
    const firstChild = createMockDiscoveryChild()
    const secondChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const env = { CODEX_HOME: '/managed/codex-discovery-descendant-home' }

    try {
      const first = discoverCommitMessageModelsLocal('codex', env)
      await vi.advanceTimersByTimeAsync(0)
      const second = discoverCommitMessageModelsLocal('codex', env)
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(first).resolves.toMatchObject({ success: false })
      expect(spawnMock).toHaveBeenCalledTimes(1)

      // A grandchild kept the inherited stdout open, so the killed child reports
      // 'exit' and 'close' never arrives.
      firstChild.emit('exit', null, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnMock).toHaveBeenCalledTimes(2)

      secondChild.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] }))
      )
      secondChild.emit('close', 0)
      await expect(second).resolves.toMatchObject({ success: true, defaultModelId: 'gpt-5.5' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles and detaches model discovery when output exceeds the limit', async () => {
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined)

    child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1))

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: 'Cursor returned too much model data.'
    })
    expectChildTerminated(child)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })
})

describe('generateCommitMessageFromContext', () => {
  it('discovers dynamic models through a remote execution plan', async () => {
    const execute = vi.fn(async (plan, cwd, timeoutMs) => {
      expect(plan).toEqual({
        binary: 'npx',
        args: ['cursor-agent', '--list-models'],
        stdinPayload: null,
        label: 'Cursor'
      })
      expect(cwd).toBe('/remote/repo')
      expect(timeoutMs).toBe(60_000)
      return {
        stdout: 'auto - Auto\ngpt-5.2 - GPT-5.2\n',
        stderr: '',
        exitCode: 0,
        timedOut: false
      }
    })

    const result = await discoverCommitMessageModelsRemote(
      'cursor',
      '/remote/repo',
      execute,
      'npx cursor-agent'
    )

    expect(result).toMatchObject({
      success: true,
      defaultModelId: 'auto',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'gpt-5.2', label: 'GPT-5.2' }
      ]
    })
  })

  it('reports remote model discovery transport timeouts without PATH guidance', async () => {
    const transportTimeout = Object.assign(
      new Error('Request "agent.execNonInteractive" timed out after 65000ms'),
      { code: SSH_MUX_REQUEST_TIMEOUT_CODE }
    )
    const result = await discoverCommitMessageModelsRemote(
      'cursor',
      '/remote/repo',
      async () => {
        throw transportTimeout
      },
      'npx cursor-agent'
    )

    expect(result).toEqual({
      success: false,
      error:
        'Cursor model discovery took longer than 60s and may still be running on the remote host.'
    })
  })

  it('reports remote model discovery spawn failures with remote install guidance', async () => {
    const result = await discoverCommitMessageModelsRemote('cursor', '/remote/repo', async () => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: 'ENOENT'
    }))

    expect(result).toEqual({
      success: false,
      error: 'cursor-agent not found on the remote PATH. Install Cursor there.'
    })
  })

  it('reuses a remote host listing per connection, and a failed one only for the retry window', async () => {
    let now = 1_000_000
    installLocalModelDiscoveryCache(createModelDiscoveryCache({ now: () => now }))
    const listed = { stdout: 'auto - Auto\n', stderr: '', exitCode: 0, timedOut: false }
    const execute = vi.fn(async () => listed)
    const discover = (connectionId?: string, cwd = '/remote/repo') =>
      discoverCommitMessageModelsRemote('cursor', cwd, execute, undefined, connectionId)
    try {
      await expect(discover('conn-1')).resolves.toMatchObject({ success: true })
      // Another worktree on the same host, same CLI and arguments: no second run there.
      await expect(discover('conn-1', '/remote/other')).resolves.toMatchObject({ success: true })
      expect(execute).toHaveBeenCalledTimes(1)
      await discover('conn-2')
      expect(execute).toHaveBeenCalledTimes(2)
      // A caller that names no connection (it rewrites the plan on its way out) always runs.
      await discover()
      expect(execute).toHaveBeenCalledTimes(3)

      now += MODEL_DISCOVERY_CACHE_TTL_MS
      execute.mockResolvedValueOnce({
        stdout: '',
        stderr: 'signed out',
        exitCode: 1,
        timedOut: false
      })
      await expect(discover('conn-1')).resolves.toMatchObject({ success: false })
      await expect(discover('conn-1')).resolves.toMatchObject({ success: false })
      expect(execute).toHaveBeenCalledTimes(4)
      now += MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS
      await expect(discover('conn-1')).resolves.toMatchObject({ success: true })
      expect(execute).toHaveBeenCalledTimes(5)
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })

  it('an explicit refresh runs a failed remote listing again at once', async () => {
    installLocalModelDiscoveryCache(createModelDiscoveryCache())
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'signed out', exitCode: 1, timedOut: false })
      .mockResolvedValue({ stdout: 'auto - Auto\n', stderr: '', exitCode: 0, timedOut: false })
    const discover = (options?: { force?: boolean }) =>
      discoverCommitMessageModelsRemote(
        'cursor',
        '/remote/repo',
        execute,
        undefined,
        'conn-1',
        options
      )
    try {
      await expect(discover()).resolves.toMatchObject({ success: false })
      await expect(discover()).resolves.toMatchObject({ success: false })
      expect(execute).toHaveBeenCalledTimes(1)
      await expect(discover({ force: true })).resolves.toMatchObject({ success: true })
      expect(execute).toHaveBeenCalledTimes(2)
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })
})
