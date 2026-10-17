// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { buildSidebarSessions } from './sidebar-sessions'
import { selectConsoleAccountScope } from './console-account-scope'
import { sidebarSessionSourceIdentity } from './sidebar-session-source-identity'
import {
  prepareSessionTaskContext,
  hasRefreshableTaskContext,
  rememberAttachedTaskContext,
  refreshSessionTaskContext
} from './session-task-context'
import { linkSessionToTask, useSessionTasks } from '@/store/session-task-store'
import type { ConsoleSessionAttachResult } from '../../../shared/console-workflow-types'

const api = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./console-workflow-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  consoleWorkflowApi: () => ({ sessionTaskContext: api.read })
}))

const attachment: ConsoleSessionAttachResult = {
  ok: true,
  taskId: 'btk_parent001',
  sessionId: 'ses_source001',
  context: {
    card_id: 'btk_parent001',
    state_revision: 4,
    available: true,
    status: 'degraded',
    context: 'Shared parent memory.\nHuman decision: preserve the original DoD.\n',
    warnings: ['Older observations omitted.'],
    scope: null,
    pack_version: 'v3',
    replies_waiting: [],
    dropped_blocks: ['history']
  }
}

function session(id = 'session-context-1', hostId = 'local') {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      workspace: [
        {
          id: `structured-agent-session-${id}`,
          entityId: id,
          contentType: 'agent-session',
          executionHostId: hostId,
          agentSessionAgent: 'codex',
          label: 'Implementation'
        }
      ]
    }
  } as never)
  const source = buildSidebarSessions(useAppStore.getState())[0]!
  linkSessionToTask(sidebarSessionSourceIdentity(source)!.sourceKey, {
    taskId: attachment.taskId!,
    sessionId: attachment.sessionId!
  })
  return source
}

beforeEach(() => {
  localStorage.clear()
  useSessionTasks.setState({ links: {}, loaded: true })
  api.read.mockReset().mockResolvedValue({ ok: true, data: attachment })
  useAppStore.setState({
    activeOrcaProfileId: 'person-a',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {}
  })
})

describe('ordinary-send refresh', () => {
  it('requires a fresh confirmed registration for an old unscoped link', async () => {
    const source = session()
    const key = sidebarSessionSourceIdentity(source)!.sourceKey
    expect(hasRefreshableTaskContext(source)).toBe(false)
    expect((await refreshSessionTaskContext('Continue', key)).text).toBe('Continue')
    expect(api.read).not.toHaveBeenCalled()
    rememberAttachedTaskContext(
      source,
      attachment,
      selectConsoleAccountScope(useAppStore.getState())
    )
    expect(hasRefreshableTaskContext(source)).toBe(true)
    prepareSessionTaskContext('First send', key).commit()
    expect(hasRefreshableTaskContext(source)).toBe(true)
    useAppStore.setState({ activeOrcaProfileId: 'person-b' })
    expect(hasRefreshableTaskContext(source)).toBe(false)
  })

  function attached() {
    const source = session()
    const key = sidebarSessionSourceIdentity(source)!.sourceKey
    rememberAttachedTaskContext(
      source,
      attachment,
      selectConsoleAccountScope(useAppStore.getState())
    )
    return key
  }

  it('injects a new file at unchanged task revision and skips an already delivered pack version', async () => {
    const key = attached()
    prepareSessionTaskContext('First send', key).commit()
    const context = {
      ...attachment.context!,
      pack_version: 'v4',
      context: 'File uploaded later: uploads/approved.pdf'
    }
    api.read.mockResolvedValue({ ok: true, data: { ...attachment, context } })
    const refreshed = await refreshSessionTaskContext('Use the upload', key, 'local')
    expect(refreshed.text).toContain(context.context)
    expect(refreshed.text).toContain('"state_revision":4')
    expect(refreshed.text).toContain('preserve any existing host-bound task authority')
    refreshed.commit()
    expect((await refreshSessionTaskContext('Continue', key, 'local')).text).toBe('Continue')
    expect(api.read).toHaveBeenCalledTimes(2)
    expect(api.read).toHaveBeenCalledWith({
      taskId: attachment.taskId,
      sessionId: attachment.sessionId
    })
  })

  it.each(['account', 'unbind', 'provider', 'host'] as const)(
    'rejects an async read after %s changes, even if an account or binding changes back',
    async (change) => {
      const key = attached()
      let resolve!: (value: unknown) => void
      api.read.mockReturnValue(
        new Promise((next) => {
          resolve = next
        })
      )
      const pending = refreshSessionTaskContext('Continue', key, 'local')
      const refused = expect(pending).rejects.toThrow()
      if (change === 'account') {
        useAppStore.setState({ activeOrcaProfileId: 'person-b' })
        useAppStore.setState({ activeOrcaProfileId: 'person-a' })
      } else if (change === 'unbind') {
        linkSessionToTask(key, null)
        linkSessionToTask(key, { taskId: attachment.taskId!, sessionId: attachment.sessionId! })
      } else if (change === 'provider') {
        session('replacement-provider')
      } else {
        session('session-context-1', 'runtime:other')
      }
      resolve({
        ok: true,
        data: {
          ...attachment,
          context: {
            ...attachment.context!,
            pack_version: 'late',
            context: 'STALE-PRIVATE-CONTEXT'
          }
        }
      })
      await refused
      expect(prepareSessionTaskContext('Continue', key, 'local').text).not.toContain(
        'STALE-PRIVATE-CONTEXT'
      )
    }
  )

  it('does not fall back to old context on a failed refresh or refresh slash commands', async () => {
    const key = attached()
    api.read.mockResolvedValue({
      ok: false,
      error: { code: 'unavailable', message: 'Context unavailable' }
    })
    await expect(refreshSessionTaskContext('Continue', key)).rejects.toThrow('Context unavailable')
    api.read.mockClear()
    expect((await refreshSessionTaskContext('/model', key)).text).toBe('/model')
    expect(api.read).not.toHaveBeenCalled()
  })

  it('keeps an older concurrent response from overwriting the newer pack', async () => {
    const key = attached()
    let finishOld!: (value: unknown) => void
    api.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve
      })
    )
    const older = refreshSessionTaskContext('Older send', key)
    const refused = expect(older).rejects.toThrow()
    api.read.mockResolvedValue({
      ok: true,
      data: {
        ...attachment,
        context: { ...attachment.context!, pack_version: 'newer', context: 'LATEST-FILE' }
      }
    })
    expect((await refreshSessionTaskContext('Newer send', key)).text).toContain('LATEST-FILE')
    finishOld({ ok: true, data: attachment })
    await refused
    expect(prepareSessionTaskContext('Continue', key).text).toContain('LATEST-FILE')
  })
})

describe('confirmed parent context delivery', () => {
  it('delivers the exact snapshot once, preserving warning and revision provenance', () => {
    const source = session()
    const scope = selectConsoleAccountScope(useAppStore.getState())
    const key = sidebarSessionSourceIdentity(source)!.sourceKey
    expect(rememberAttachedTaskContext(source, attachment, scope)).toBe(true)
    expect(prepareSessionTaskContext('Continue', 'another-session', 'local').text).toBe('Continue')
    expect(prepareSessionTaskContext('/model', key, 'local').text).toBe('/model')
    const prepared = prepareSessionTaskContext('Continue', key, 'local')
    expect(prepared.text).toContain(attachment.context!.context)
    expect(prepared.text).toContain('"state_revision":4')
    expect(prepared.text).toContain('"warnings":["Older observations omitted."]')
    expect(prepareSessionTaskContext(prepared.text, key, 'local').text).toBe(prepared.text)
    prepared.commit()
    expect(prepareSessionTaskContext('Continue again', key, 'local').text).toBe('Continue again')
  })

  it('does not lend memory across account, host, or session identity changes', () => {
    const source = session()
    const scope = selectConsoleAccountScope(useAppStore.getState())
    const key = sidebarSessionSourceIdentity(source)!.sourceKey
    rememberAttachedTaskContext(source, attachment, scope)
    useAppStore.setState({ activeOrcaProfileId: 'person-b' })
    expect(prepareSessionTaskContext('Continue', key, 'local').text).toBe('Continue')
    useAppStore.setState({ activeOrcaProfileId: 'person-a' })
    expect(prepareSessionTaskContext('Continue', key, 'runtime:other').text).toBe('Continue')
    session('different-session')
    expect(prepareSessionTaskContext('Continue', key, 'local').text).toBe('Continue')
  })

  it('requires confirmed attachment IDs and actual memory; an old client result grants no context', () => {
    const source = session()
    const scope = selectConsoleAccountScope(useAppStore.getState())
    const key = sidebarSessionSourceIdentity(source)!.sourceKey
    expect(rememberAttachedTaskContext(source, { ok: true }, scope)).toBe(false)
    expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
    rememberAttachedTaskContext(source, attachment, scope)
    expect(rememberAttachedTaskContext(source, { ...attachment, context: undefined }, scope)).toBe(
      false
    )
    expect(prepareSessionTaskContext('Continue', key).text).toBe('Continue')
  })

  it('does not use provisional terminal pane identity for private parent memory', () => {
    const source = session()
    expect(
      rememberAttachedTaskContext(
        { ...source, kind: 'terminal', sessionKey: '["local","pane","workspace","pane"]' },
        attachment,
        selectConsoleAccountScope(useAppStore.getState())
      )
    ).toBe(false)
  })

  it('refuses an oversized saved receipt before claiming it is remembered', () => {
    const source = session()
    const scope = selectConsoleAccountScope(useAppStore.getState())
    rememberAttachedTaskContext(source, attachment, scope)
    expect(
      rememberAttachedTaskContext(
        source,
        {
          ...attachment,
          context: { ...attachment.context!, warnings: ['x'.repeat(80_000)] }
        },
        scope
      )
    ).toBe(false)
    expect(
      prepareSessionTaskContext('Continue', sidebarSessionSourceIdentity(source)!.sourceKey).text
    ).toBe('Continue')
  })
})
