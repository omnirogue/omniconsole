// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistedBriefGenerateResult } from '../../../../../shared/assisted-brief-contract'
import type { BriefActor } from '../../../../../shared/assisted-brief-types'
import type { BriefWorkspace } from './assisted-brief-workspace'

const runner = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn() }))
vi.mock('./assisted-brief-runner-client', () => ({
  runBriefGeneration: runner.run,
  cancelBriefGeneration: runner.cancel
}))

const { useBriefGeneration } = await import('./use-brief-generation')

const WORKSPACE: BriefWorkspace = {
  worktreeId: 'repo-1::/work/app',
  workspaceKey: '["repo-1::/work/app","local"]',
  label: 'app',
  kind: 'git',
  worktreePath: '/work/app',
  paired: false
}
const ACTOR: BriefActor = {
  agent: 'claude',
  model: 'claude-fable-5-1[1m]',
  label: 'Claude Teams · Fable'
}

/** The next run stays in flight until the returned function settles it. */
function pendingRun(): (result: AssistedBriefGenerateResult) => void {
  let settle: (result: AssistedBriefGenerateResult) => void = () => {}
  runner.run.mockReturnValueOnce(
    new Promise<AssistedBriefGenerateResult>((resolve) => {
      settle = resolve
    })
  )
  return (result) => settle(result)
}

beforeEach(() => {
  runner.run.mockReset()
  runner.cancel.mockReset()
})

describe('brief generation lifetime', () => {
  it('stops a draft that is still running when the drawer closes', async () => {
    const settle = pendingRun()
    const { result, unmount } = renderHook(() => useBriefGeneration(WORKSPACE))
    let reply: Promise<string | null> = Promise.resolve('not started')
    act(() => {
      reply = result.current.run({ purpose: 'draft', actor: ACTOR }, 'prompt')
    })
    unmount()
    expect(runner.cancel).toHaveBeenCalledWith(WORKSPACE)
    settle({ ok: false, error: 'Generation canceled.', canceled: true })
    await expect(reply).resolves.toBeNull()
  })

  it('runs one at a time and leaves a finished run alone when the drawer closes', async () => {
    const settle = pendingRun()
    const { result, unmount } = renderHook(() => useBriefGeneration(WORKSPACE))
    let first: Promise<string | null> = Promise.resolve('not started')
    act(() => {
      first = result.current.run({ purpose: 'draft', actor: ACTOR }, 'one')
    })
    await expect(result.current.run({ purpose: 'draft', actor: ACTOR }, 'two')).resolves.toBeNull()
    expect(runner.run).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle({ ok: true, text: '{"outcome":"A summary"}', actorLabel: 'Claude' })
      await first
    })
    await expect(first).resolves.toBe('{"outcome":"A summary"}')
    unmount()
    expect(runner.cancel).not.toHaveBeenCalled()
  })
})
