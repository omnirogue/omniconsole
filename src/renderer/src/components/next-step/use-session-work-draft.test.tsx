// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import {
  Suspense,
  startTransition,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextStepSubject } from './next-step-subject'
import { emptyNextStepDraft } from '../../../../shared/next-step-draft'
import {
  readSessionWorkDraft,
  sessionWorkDraftKey,
  useSessionWorkDraft,
  writeSessionWorkDraft
} from './use-session-work-draft'

const scope = vi.hoisted(() => ({ account: 'account-a' }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `${scope.account}:${key}`
}))
const subject: Extract<NextStepSubject, { kind: 'session' }> = {
  kind: 'session',
  session: {
    rowKey: 'row',
    sessionKey: 'provider-session',
    hostId: 'local',
    worktreeId: 'folder:work',
    tabId: 'tab',
    paneKey: 'tab:leaf',
    kind: 'terminal',
    label: 'Agent one',
    workspaceLabel: 'Work',
    agent: 'omp',
    unavailable: false,
    folderKeyMigration: null
  }
}
beforeEach(() => {
  localStorage.clear()
  scope.account = 'account-a'
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('session work drafts', () => {
  it('moves provisional pane drafts once when provider session identity arrives', () => {
    const provisional = { ...subject, session: { ...subject.session, sessionKey: 'provisional' } }
    writeSessionWorkDraft(sessionWorkDraftKey(provisional, 'outcome'), 'keep edits')
    const resolved = {
      ...subject,
      session: {
        ...subject.session,
        folderKeyMigration: { from: 'provisional', to: subject.session.sessionKey! }
      }
    }
    const hook = renderHook(() => useSessionWorkDraft(resolved, 'outcome', () => 'empty'))
    expect(hook.result.current[0]).toBe('keep edits')
    expect(readSessionWorkDraft(sessionWorkDraftKey(resolved, 'outcome'))).toBe('keep edits')
    expect(readSessionWorkDraft(sessionWorkDraftKey(provisional, 'outcome'))).toBeUndefined()
  })

  it('retains the entire model, handoff, outcome and file draft across surface remount and a fresh module', async () => {
    const hook = renderHook(() => useSessionWorkDraft(subject, 'handoff', emptyNextStepDraft))
    const draft = {
      ...emptyNextStepDraft(),
      note: 'Keep all edits',
      recipients: [
        {
          kind: 'agent' as const,
          key: 'omp',
          agent: 'omp' as const,
          model: 'openrouter/google/gemini-2.5-pro',
          openrouterCandidates: ['google/gemini-2.5-pro', 'moonshotai/kimi-k2.5', 'x-ai/grok-4.5'],
          presetId: null,
          instructions: 'Review this',
          rounds: 1
        }
      ],
      after: [
        {
          kind: 'agent' as const,
          key: 'review',
          actor: {
            agent: 'omp' as const,
            model: 'openrouter/x-ai/grok-4.5',
            openrouterCandidates: ['x-ai/grok-4.5', 'google/gemini-2.5-pro']
          },
          presetId: 'review' as const,
          instructions: 'Keep this different route order',
          rounds: 1
        }
      ],
      handoff: {
        includeSummary: true,
        includeTranscript: true,
        task: { id: 'task', title: 'Review' },
        deliverables: { kind: 'files' as const, paths: ['report.md'] }
      }
    }
    act(() => hook.result.current[1](draft))
    hook.unmount()
    const remount = renderHook(() => useSessionWorkDraft(subject, 'handoff', emptyNextStepDraft))
    expect(remount.result.current[0]).toEqual(draft)
    const key = sessionWorkDraftKey(subject, 'handoff')
    vi.resetModules()
    const fresh = await import('./use-session-work-draft')
    expect(fresh.readSessionWorkDraft(key)).toEqual(draft)
  })

  it('isolates siblings, hosts, accounts and editor kinds while retaining a renamed session', () => {
    const key = sessionWorkDraftKey(subject, 'outcome')
    writeSessionWorkDraft(key, { timing: 'now', dirty: true, draft: emptyNextStepDraft() })
    expect(
      sessionWorkDraftKey(
        { ...subject, session: { ...subject.session, label: 'Renamed' } },
        'outcome'
      )
    ).toBe(key)
    for (const session of [
      { ...subject.session, sessionKey: 'sibling', paneKey: 'tab:other' },
      { ...subject.session, hostId: 'ssh:other' as const }
    ]) {
      expect(
        readSessionWorkDraft(sessionWorkDraftKey({ ...subject, session }, 'outcome'))
      ).toBeUndefined()
    }
    expect(readSessionWorkDraft(sessionWorkDraftKey(subject, 'fleet'))).toBeUndefined()
    scope.account = 'account-b'
    expect(readSessionWorkDraft(sessionWorkDraftKey(subject, 'outcome'))).toBeUndefined()
  })

  it('changes the editor owner synchronously and never writes the previous pane draft into its sibling', () => {
    const sibling = { ...subject, session: { ...subject.session, sessionKey: 'other' } }
    const hook = renderHook(({ owner }) => useSessionWorkDraft(owner, 'outcome', () => 'empty'), {
      initialProps: { owner: subject }
    })
    act(() => hook.result.current[1]('pane one'))
    hook.rerender({ owner: sibling })
    expect(hook.result.current[0]).toBe('empty')
    act(() => hook.result.current[1]('pane two'))
    hook.rerender({ owner: subject })
    expect(hook.result.current[0]).toBe('pane one')
    act(() => hook.result.current[2]())
    expect(localStorage.getItem(sessionWorkDraftKey(subject, 'outcome'))).toBeNull()
    expect(readSessionWorkDraft(sessionWorkDraftKey(sibling, 'outcome'))).toBe('pane two')
  })

  it('does not claim persistence when storage refuses a write', () => {
    const key = sessionWorkDraftKey(subject, 'fleet')
    writeSessionWorkDraft(key, { note: 'saved' })
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => writeSessionWorkDraft(key, { note: 'unsaved' })).toThrow('disk full')
    write.mockRestore()
    expect(readSessionWorkDraft(key)).toEqual({ note: 'saved' })
  })

  it('keeps the committed owner fallback when another owner render suspends', () => {
    const sibling = {
      ...subject,
      session: { ...subject.session, sessionKey: 'other', label: 'Agent two' }
    }
    const suspended = new Promise<never>(() => {})
    const attempted = vi.fn()
    let update: Dispatch<SetStateAction<string>> = () => {
      throw new Error('No committed editor')
    }
    function Probe({ owner }: { owner: typeof subject }) {
      const [, setValue] = useSessionWorkDraft(owner, 'outcome', () => owner.session.label)
      useLayoutEffect(() => {
        update = setValue
      }, [setValue])
      if (owner === sibling) {
        attempted()
        throw suspended
      }
      return null
    }
    const view = render(
      <Suspense>
        <Probe owner={subject} />
      </Suspense>
    )
    const committedUpdate = update
    act(() => {
      startTransition(() =>
        view.rerender(
          <Suspense>
            <Probe owner={sibling} />
          </Suspense>
        )
      )
    })
    expect(attempted).toHaveBeenCalled()
    act(() => committedUpdate((value) => `${value} edited`))
    expect(readSessionWorkDraft(sessionWorkDraftKey(subject, 'outcome'))).toBe('Agent one edited')
    expect(readSessionWorkDraft(sessionWorkDraftKey(sibling, 'outcome'))).toBeUndefined()
  })
})
