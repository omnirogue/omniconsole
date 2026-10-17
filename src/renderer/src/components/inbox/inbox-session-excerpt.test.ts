import { beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { readRoomSessionExcerpts } from './inbox-session-excerpt'

const localRead = vi.fn()
const remoteRead = vi.fn()
const session: SidebarSession = {
  rowKey: 'row',
  folderKeyMigration: null,
  sessionKey: 'provider-session',
  worktreeId: 'folder:notes',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal',
  label: 'Investigate',
  workspaceLabel: 'Notes',
  agent: 'claude',
  unavailable: false,
  providerSession: {
    key: 'session_id',
    id: 'provider-one',
    transcriptPath: '/private/transcript.jsonl'
  }
}
const result = {
  messages: [
    {
      id: 'm1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Useful answer' }],
      timestamp: 1,
      source: 'transcript'
    }
  ]
}
beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.stubGlobal('window', {
    location: { pathname: '/index.html' },
    api: {
      nativeChat: { readSession: localRead },
      runtimeEnvironments: { call: remoteRead }
    }
  })
})
it('routes runtime excerpts only to their owning host with provider identity', async () => {
  markRuntimeEnvironmentCompatible('remote-one')
  remoteRead.mockResolvedValue({ ok: true, result })
  expect(await readRoomSessionExcerpts({ ...session, hostId: 'runtime:remote-one' })).toEqual([
    'AI: Useful answer'
  ])
  expect(remoteRead).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: 'remote-one',
      method: 'nativeChat.readSession',
      params: {
        agent: 'claude',
        sessionId: 'provider-one',
        limit: 6,
        transcriptPath: '/private/transcript.jsonl'
      }
    })
  )
  expect(localRead).not.toHaveBeenCalled()
})
it('does not fall back locally after remote failure or unknown/SSH ownership', async () => {
  markRuntimeEnvironmentCompatible('remote-one')
  remoteRead.mockRejectedValue(new Error('Disconnected'))
  await expect(
    readRoomSessionExcerpts({ ...session, hostId: 'runtime:remote-one' })
  ).rejects.toThrow()
  for (const hostId of [null, 'ssh:server', 'unknown'] as const) {
    await expect(
      readRoomSessionExcerpts({ ...session, hostId: hostId as SidebarSession['hostId'] })
    ).rejects.toThrow('owning host')
  }
  expect(localRead).not.toHaveBeenCalled()
  expect(remoteRead).toHaveBeenCalledTimes(1)
})
it('omits tool/thinking content and reports text truncation for local excerpts', async () => {
  localRead.mockResolvedValue({
    messages: [
      {
        ...result.messages[0],
        blocks: [
          { type: 'thinking', text: 'Private reasoning' },
          { type: 'text', text: 'x'.repeat(2100) },
          { type: 'tool_use', name: 'read_file', input: { path: '/secret' } }
        ]
      }
    ]
  })
  const excerpts = await readRoomSessionExcerpts(session)
  expect(excerpts).toEqual([`AI: ${'x'.repeat(2000)}\n[Excerpt truncated]`])
  expect(remoteRead).not.toHaveBeenCalled()
})
