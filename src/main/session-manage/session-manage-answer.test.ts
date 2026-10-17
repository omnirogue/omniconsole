import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManageActor, SessionPromptAnswer } from '../../shared/session-manage-types'
import {
  answerHardStop,
  answerSession,
  selectSessionAnswer,
  withSessionAnswerLock as withAnswerLock,
  type SessionAnswerDeps,
  type SessionAnswerLock
} from './session-manage-answer'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import { agentProcess, manageEntry } from './session-manage-test-fixtures'
import { describeSessionPrompt, persistentApproval, type SessionPrompt } from './session-prompt'
import { parseSessionPromptScreen } from './session-prompt-screen'
import { setNextStepSuggestionService } from '../next-steps/next-step-suggestion-slot'

const pendingAnswers = new Set<string>()
beforeEach(() => pendingAnswers.clear())
const withSessionAnswerLock = <T>(key: string, task: (lock: SessionAnswerLock) => Promise<T>) =>
  withAnswerLock(key, task, pendingAnswers)

const actor: SessionManageActor = { kind: 'pane', paneKey: 'manager:pane', title: 'Manager [ops]' }

function permission(text = 'Bash\npwd', commandText: string[] = []): SessionPrompt {
  const options = [
    { n: 1, label: "Yes, and don't ask again", value: 'allowForSession' },
    { n: 2, label: 'Allow', value: 'allow', role: 'allow-once' as const },
    { n: 3, label: 'Deny', value: 'deny', role: 'deny' as const }
  ]
  return {
    ask: describeSessionPrompt('permission', text, options, true, commandText),
    options,
    readable: true,
    subject: text,
    commandText,
    delivery: { kind: 'structured', sessionId: 'chat', itemId: 'item', fence: 1, revision: 1 }
  }
}

function question(label = 'Existing parser'): SessionPrompt {
  const options = [
    { n: 1, label, value: 'q1:choice-1' },
    { n: 2, label: 'No', value: 'q1:choice-2' }
  ]
  return {
    ask: describeSessionPrompt('question', 'Which implementation?', options, true),
    options,
    readable: true,
    subject: 'Which implementation?',
    commandText: [],
    delivery: {
      kind: 'structured',
      sessionId: 'chat',
      itemId: 'item',
      fence: 1,
      revision: 1,
      freeTextQuestionId: 'q1'
    }
  }
}

/** Claude's real permission menu, as `session-prompt-screen.test.ts` reads it. */
function screenPermission(command = 'git status --short', hook?: string): SessionPrompt {
  const screen = `Bash command\n  ${command}\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for git status commands\n  3. No\nEsc to cancel · Tab to amend`
  const parsed = parseSessionPromptScreen('claude', screen, hook)!
  return { ...parsed, delivery: { kind: 'pty', handle: 'term_2', ptyId: 'pty-1', screen } }
}

/** A reading consistent with the prompt: a chat for a structured prompt, a terminal for a PTY. */
function setup(prompt: SessionPrompt = permission()) {
  const pty = prompt.delivery.kind === 'pty'
  const entry = manageEntry({
    state: 'awaiting-user',
    keepGoing: true,
    ask: prompt.ask,
    kind: pty ? 'terminal' : 'chat',
    agentForeground: pty ? true : null
  })
  const source = pty
    ? { kind: 'pty' as const, worktreeId: entry.worktreeId, paneKey: entry.paneKey! }
    : {
        kind: 'structured' as const,
        worktreeId: entry.worktreeId,
        paneKey: entry.paneKey!,
        sessionId: 'chat'
      }
  const proof =
    prompt.delivery.kind === 'pty' ? agentProcess({ ptyId: prompt.delivery.ptyId }) : null
  const reading: {
    entry: typeof entry
    source: typeof source
    prompt: SessionPrompt
    agentProcess: typeof proof
  } = { entry, source, prompt, agentProcess: proof }
  const read = vi.fn(async () => reading)
  const preflight = vi.fn<NonNullable<SessionAnswerDeps['preflight']>>(async () => {})
  const recheck = vi.fn<SessionAnswerDeps['recheck']>(async () => {})
  const stopKeepGoing = vi.fn(() => true)
  const deliver = vi.fn<SessionAnswerDeps['deliver']>(async () => ({ status: 'recorded' }))
  const deps = { read, preflight, recheck, stopKeepGoing, deliver }
  const lock = {
    uncertain: false,
    bindPrompt: vi.fn(),
    admit: vi.fn(),
    markUncertain: vi.fn(),
    leftPrompt: vi.fn()
  } satisfies SessionAnswerLock
  const run = (answer: SessionPromptAnswer, overrides = {}) =>
    answerSession(deps, {
      actor,
      expect: prompt.ask.fingerprint,
      answer,
      dryRun: false,
      lock,
      ...overrides
    })
  return { deps, run, entry, prompt, reading, lock }
}

describe('session answer', () => {
  it('persists the pending answer before stopping Keep going or dispatching', async () => {
    const { deps, lock, run } = setup()
    await run({ kind: 'allow' })
    expect(lock.markUncertain.mock.invocationCallOrder[0]).toBeLessThan(
      deps.stopKeepGoing.mock.invocationCallOrder[0]
    )
    expect(lock.markUncertain.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deliver.mock.invocationCallOrder[0]
    )
    expect(lock.leftPrompt).not.toHaveBeenCalled()
  })

  it('sends nothing if the pending marker cannot be saved', async () => {
    const { deps, lock, run } = setup()
    lock.markUncertain.mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })
    await expect(run({ kind: 'allow' })).rejects.toThrow('disk unavailable')
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it('clears the marker only after a proven no-write refusal', async () => {
    const { deps, lock, run } = setup()
    deps.deliver.mockRejectedValueOnce(new SessionManageRefusal('owner refused; Nothing was sent.'))
    await expect(run({ kind: 'allow' })).rejects.toThrow('owner refused')
    expect(lock.leftPrompt).toHaveBeenCalledOnce()
  })

  it('re-reads the prompt, turns Keep going off first, and chooses one-time allow even when it is not first', async () => {
    const { deps, run } = setup()
    const result = await run({ kind: 'allow' })
    expect(result).toMatchObject({
      action: 'answer',
      chosen: { n: 2, label: 'Allow' },
      delivery: 'recorded'
    })
    expect(deps.read).toHaveBeenCalledOnce()
    expect(deps.stopKeepGoing.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deliver.mock.invocationCallOrder[0]!
    )
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ value: 'allow' }),
      actor,
      null
    )
  })

  it('refuses a fingerprint mismatch before any mutation', async () => {
    const { deps, run } = setup()
    await expect(
      run({ kind: 'allow' }, { expect: permission('Bash\nls').ask.fingerprint })
    ).rejects.toThrow('fingerprint mismatch')
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it.each([
    'deploy the app',
    'git push origin main',
    'git push --force',
    'rm ../report',
    'rm note.txt',
    'git reset --hard',
    'send a message to Sal',
    'pay the invoice',
    'read credentials',
    'chmod 777 file'
  ])('refuses allow for %s but still permits deny', async (text) => {
    const { deps, run } = setup(permission(`Bash\n${text}`))
    await expect(run({ kind: 'allow' })).rejects.toThrow('hard stop')
    expect(deps.deliver).not.toHaveBeenCalled()
    expect(await run({ kind: 'deny' })).toMatchObject({ chosen: { n: 3, label: 'Deny' } })
  })

  it('never chooses persistent approval, including a misleading one-time role', () => {
    const prompt = permission()
    prompt.options = [
      { n: 1, label: "Don't ask again", value: 'allowForSession', role: 'allow-once' }
    ]
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, actor)).toThrow(
      'no unambiguous one-time allow'
    )
    expect(() => selectSessionAnswer(permission(), { kind: 'choose', choice: 1 }, actor)).toThrow(
      'require a question'
    )
  })

  it('treats allow-all wording as persistent but not a one-time label joined to its id', () => {
    for (const text of ['Allow all', 'allowAll', 'allow-all', 'allow_all', 'Allow all edits']) {
      expect(persistentApproval(text)).toBe(true)
    }
    expect(persistentApproval('Allow allow')).toBe(false)
    expect(persistentApproval('allow Allow')).toBe(false)
  })

  it('refuses unreadable allow while deny still works', async () => {
    const prompt = permission()
    prompt.readable = false
    const { run } = setup(prompt)
    await expect(run({ kind: 'allow' })).rejects.toThrow('cannot be read completely')
    await expect(run({ kind: 'deny' })).resolves.toMatchObject({ chosen: { label: 'Deny' } })
  })

  it('checks question context and option labels without treating a question option as a permission denial', async () => {
    await expect(
      setup(question('Deploy the app')).run({ kind: 'choose', choice: 1 })
    ).rejects.toThrow('hard stop')
    const prompt = question('Yes')
    prompt.ask = describeSessionPrompt('question', 'Deploy now?', prompt.options, true)
    await expect(setup(prompt).run({ kind: 'choose', choice: 1 })).rejects.toThrow('hard stop')
    await expect(setup(prompt).run({ kind: 'deny' })).rejects.toThrow('require a permission prompt')
  })

  it('refuses a question whose hard-stop command is split across lines', () => {
    const prompt = question('Yes')
    prompt.ask = describeSessionPrompt(
      'question',
      'Should I git\npush origin feature?',
      prompt.options,
      true
    )
    expect(() =>
      selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, { kind: 'cli' })
    ).toThrow('hard stop')
  })

  it('marks free text with the actor and checks it for hard stops', async () => {
    const { deps, run } = setup(question())
    await expect(run({ kind: 'text', text: 'Use the existing parser' })).resolves.toMatchObject({
      chosen: { label: '[from Manager ops] Use the existing parser' }
    })
    expect(deps.deliver.mock.calls[0]?.[1].value).toBe(
      'q1:%5Bfrom%20Manager%20ops%5D%20Use%20the%20existing%20parser'
    )
    await expect(run({ kind: 'text', text: 'send an email' })).rejects.toThrow('hard stop')
    await expect(run({ kind: 'text', text: 'Always allow' })).rejects.toThrow('Persistent approval')
    await expect(run({ kind: 'text', text: '\x1b[20~' })).rejects.toThrow('control characters')
  })

  it('refuses PTY free text rather than typing into an unverified editor', async () => {
    const prompt = question()
    prompt.delivery = { kind: 'pty', handle: 'term_2', ptyId: 'pty', screen: 'screen' }
    await expect(
      setup(prompt).run({ kind: 'text', text: 'Use the existing parser' })
    ).rejects.toThrow('Free text is unsupported')
  })

  it('dry-run returns the exact prompt and answer without changing Keep going or sending', async () => {
    const { deps, run, prompt } = setup()
    expect(await run({ kind: 'allow' }, { dryRun: true })).toMatchObject({
      ask: prompt.ask,
      chosen: { n: 2, label: 'Allow' },
      delivery: 'dry-run'
    })
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'idle', 'working', 'exited'] as const)(
    'refuses the %s state even for denial',
    async (state) => {
      const { entry, deps, run } = setup()
      entry.state = state
      await expect(run({ kind: 'deny' })).rejects.toThrow('Nothing was sent')
      expect(deps.deliver).not.toHaveBeenCalled()
    }
  )

  it('refuses an unverifiable target and its own pane', async () => {
    const { entry, run } = setup()
    entry.verdict = 'unverifiable'
    await expect(run({ kind: 'deny' })).rejects.toThrow('unverifiable')
    entry.verdict = 'live'
    entry.paneKey = actor.paneKey
    await expect(run({ kind: 'deny' })).rejects.toThrow('cannot answer itself')
  })

  it('reports an unconfirmed answer with its reason and closes that prompt to another answer', async () => {
    const { deps, run, lock } = setup()
    deps.deliver.mockResolvedValue({
      status: 'unconfirmed',
      reason: 'its screen could not be read'
    })
    expect(await run({ kind: 'allow' })).toMatchObject({
      delivery: 'unconfirmed',
      summary: expect.stringMatching(
        /its screen could not be read\. Inspect the session before retrying/
      )
    })
    expect(lock.markUncertain).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ask: expect.any(Object), chosen: expect.any(Object) })
    )
  })

  it('refuses a second answer to a prompt left unconfirmed', async () => {
    const { deps, prompt } = setup()
    deps.deliver.mockResolvedValueOnce({
      status: 'unconfirmed',
      reason: 'the prompt was still showing'
    })
    const answer = () =>
      withSessionAnswerLock('pane-unconfirmed', (lock) =>
        answerSession(deps, {
          actor,
          expect: prompt.ask.fingerprint,
          answer: { kind: 'allow' },
          dryRun: false,
          lock
        })
      )
    await expect(answer()).resolves.toMatchObject({ delivery: 'unconfirmed' })
    await expect(answer()).rejects.toThrow('may already have reached it')
    expect(deps.deliver).toHaveBeenCalledOnce()
  })

  it('serializes attempts to the same pane and releases its lock after failure', async () => {
    await withSessionAnswerLock('pane', async () => {
      await expect(withSessionAnswerLock('pane', async () => true)).rejects.toThrow(
        'already in progress'
      )
    })
    await expect(withSessionAnswerLock('pane', async () => true)).resolves.toBe(true)
  })

  // MINOR-1: a prompt answered or replaced meanwhile refuses with Keep going untouched.
  it('re-reads the prompt right before Keep going changes, and refuses there with nothing done', async () => {
    const { deps, run } = setup()
    await run({ kind: 'allow' })
    expect(deps.recheck).toHaveBeenCalledOnce()
    expect(deps.recheck.mock.invocationCallOrder[0]).toBeLessThan(
      deps.stopKeepGoing.mock.invocationCallOrder[0]!
    )
    deps.stopKeepGoing.mockClear()
    deps.recheck.mockRejectedValueOnce(
      new SessionManageRefusal('The prompt identity, options or screen changed. Nothing was sent.')
    )
    const failure = await run({ kind: 'allow' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionManageRefusal)
    expect(failure).not.toBeInstanceOf(SessionManagePartialError)
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
  })

  // MAJOR-6: past a refusal the answer may have landed; that is never a normal result.
  it('reports a failure after the answer may have been sent as partly applied, never a result', async () => {
    const { deps, run, lock } = setup()
    deps.deliver.mockRejectedValue(new Error('SSH disconnected after write'))
    const failure = await run({ kind: 'allow' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionManagePartialError)
    expect(failure).toMatchObject({
      applied: 'its Keep going was turned off, and the answer may have been sent'
    })
    expect((failure as Error).message).toContain('SSH disconnected after write')
    expect((failure as Error).message).toContain('inspect it before answering again')
    expect(lock.markUncertain).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ask: expect.any(Object), chosen: expect.any(Object) })
    )
    deps.stopKeepGoing.mockReturnValue(false)
    await expect(run({ kind: 'allow' })).rejects.toMatchObject({
      applied: 'the answer may have been sent'
    })
  })

  it('keeps quarantine across different commands until departure is verified', async () => {
    const { deps, prompt, reading } = setup()
    deps.deliver.mockRejectedValueOnce(new Error('write failed after reservation'))
    const answer = (fingerprint: string, dryRun = false) =>
      withSessionAnswerLock('pane-uncertain', (lock) =>
        answerSession(deps, { actor, expect: fingerprint, answer: { kind: 'allow' }, dryRun, lock })
      )
    await expect(answer(prompt.ask.fingerprint)).rejects.toBeInstanceOf(SessionManagePartialError)
    await expect(answer(prompt.ask.fingerprint)).rejects.toThrow('may already have reached it')
    await expect(answer(prompt.ask.fingerprint, true)).rejects.toThrow(
      'may already have reached it'
    )
    expect(deps.deliver).toHaveBeenCalledOnce()
    // Different text cannot prove a menu closed.
    const next = permission('Bash\nls')
    reading.prompt = next
    reading.entry.ask = next.ask
    await expect(answer(next.ask.fingerprint)).rejects.toThrow('may already have reached it')
    reading.prompt = prompt
    reading.entry.ask = prompt.ask
    await expect(answer(prompt.ask.fingerprint)).rejects.toThrow('may already have reached it')
  })
})

describe('session answer: the uncertain-answer quarantine', () => {
  const hookFor = (summary: string) => JSON.stringify({ approval: { tool: 'Bash', summary } })

  // MAJOR-R2-2: keyed on the prompt's stable identity, never on its volatile fingerprint.
  it('keeps the quarantine when a hook arrives late or readability flips on the same prompt', async () => {
    const first = screenPermission()
    const { deps, reading } = setup(first)
    deps.deliver.mockRejectedValueOnce(new Error('write failed after reservation'))
    const answer = (prompt: SessionPrompt, kind: 'allow' | 'deny' = 'allow') => {
      reading.prompt = prompt
      reading.entry.ask = prompt.ask
      return withSessionAnswerLock('pane-identity', (lock) =>
        answerSession(deps, {
          actor,
          expect: prompt.ask.fingerprint,
          answer: { kind },
          dryRun: false,
          lock
        })
      )
    }
    await expect(answer(first)).rejects.toBeInstanceOf(SessionManagePartialError)
    const withHook = screenPermission('git status --short', hookFor('git status --short'))
    const clipped = screenPermission('git status --sh…')
    expect(withHook.ask.fingerprint).not.toBe(first.ask.fingerprint)
    expect(clipped.ask.fingerprint).not.toBe(first.ask.fingerprint)
    expect(clipped.readable).toBe(false)
    await expect(answer(withHook)).rejects.toThrow('may already have reached it')
    await expect(answer(clipped, 'deny')).rejects.toThrow('may already have reached it')
    await expect(answer(first, 'deny')).rejects.toThrow('may already have reached it')
    expect(deps.deliver).toHaveBeenCalledOnce()
    await expect(answer(screenPermission('git log --oneline'))).rejects.toThrow(
      'may already have reached it'
    )
  })

  it('keeps quarantine after contradictory state-only readings', async () => {
    const { deps, reading, prompt } = setup(screenPermission())
    deps.deliver.mockRejectedValueOnce(new Error('write failed after reservation'))
    const answer = () =>
      withSessionAnswerLock('pane-left', (lock) =>
        answerSession(deps, {
          actor,
          expect: prompt.ask.fingerprint,
          answer: { kind: 'allow' },
          dryRun: false,
          lock
        })
      )
    await expect(answer()).rejects.toBeInstanceOf(SessionManagePartialError)
    // Unknown or unproven readings in between release nothing.
    for (const [state, stateBasis] of [
      ['unknown', 'none'],
      ['idle', 'last-report'],
      ['working', 'process']
    ] as const) {
      Object.assign(reading.entry, { state, stateBasis })
      await expect(answer()).rejects.toThrow('Nothing was sent')
      Object.assign(reading.entry, { state: 'awaiting-user', stateBasis: 'screen' })
      await expect(answer()).rejects.toThrow('may already have reached it')
    }
    Object.assign(reading.entry, { state: 'working', stateBasis: 'hook' })
    await expect(answer()).rejects.toThrow('not awaiting-user')
    Object.assign(reading.entry, { state: 'awaiting-user', stateBasis: 'screen' })
    await expect(answer()).rejects.toThrow('may already have reached it')
  })
})

describe('session answer: what can be chosen', () => {
  it('refuses persistent permission headers while still allowing a separate one-time menu choice', () => {
    const scoped = permission('Allow Bash commands for this session?', ['pwd'])
    expect(() => selectSessionAnswer(scoped, { kind: 'allow' }, actor)).toThrow(
      'persistent or scoped'
    )
    expect(selectSessionAnswer(scoped, { kind: 'deny' }, actor).value).toBe('deny')
    expect(selectSessionAnswer(screenPermission(), { kind: 'allow' }, actor).value).toBe('1')
  })

  // MAJOR-3: persistent or scoped approvals are never picked or sent, on any path.
  it.each([
    'Yes, allow for this directory',
    'Allow for this project',
    'Allow for this workspace',
    'Yes, permanently',
    'Yes, allow all edits during this session'
  ])('--choose refuses the question option %s', async (label) => {
    const { deps, run } = setup(question(label))
    await expect(run({ kind: 'choose', choice: 1 })).rejects.toThrow('Persistent approval')
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it.each(['yes for this directory', 'Allow it for the whole project', 'approve it permanently'])(
    '--text refuses %s',
    async (text) => {
      const { deps, run } = setup(question())
      await expect(run({ kind: 'text', text })).rejects.toThrow('Persistent approval')
      expect(deps.deliver).not.toHaveBeenCalled()
    }
  )

  it('never answers a permission prompt with --choose or --text', () => {
    for (const answer of [
      { kind: 'choose', choice: 2 },
      { kind: 'text', text: 'Allow' }
    ] as const) {
      expect(() => selectSessionAnswer(permission(), answer, actor)).toThrow('require a question')
    }
  })

  // MAJOR-3-B: a free-entry row before the last refuses the whole question, every choice.
  it.each(['Other', 'Other (specify)', 'Type something.', 'None of the above'])(
    'refuses every choice of a question with the free-entry option %s in the middle',
    (label) => {
      const prompt = question()
      prompt.options = [
        prompt.options[0]!,
        { n: 2, label, value: 'q1:choice-2' },
        { n: 3, label: 'Cancel', value: 'q1:choice-3' }
      ]
      for (const choice of [1, 2, 3]) {
        expect(() => selectSessionAnswer(prompt, { kind: 'choose', choice }, actor)).toThrow(
          'free-entry'
        )
      }
      expect(() =>
        selectSessionAnswer(prompt, { kind: 'text', text: 'Use the parser' }, actor)
      ).toThrow('free-entry')
    }
  )

  it.each(['Other', 'None of the above'])(
    'never chooses a trailing %s but still answers its siblings',
    (label) => {
      const prompt = question()
      prompt.options = [...prompt.options, { n: 3, label, value: 'q1:choice-3' }]
      expect(() => selectSessionAnswer(prompt, { kind: 'choose', choice: 3 }, actor)).toThrow(
        'free-entry'
      )
      expect(selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, actor).value).toBe(
        'q1:choice-1'
      )
    }
  )

  it.each([
    ['no key', ''],
    ['a key with Enter', '1\r'],
    ['another option digit', '2'],
    ['an escape sequence', '\x1b[B']
  ])('refuses a terminal question option with %s', (_name, value) => {
    const prompt = question()
    prompt.delivery = { kind: 'pty', handle: 'term_2', ptyId: 'pty-1', screen: 'screen' }
    prompt.options = [
      { n: 1, label: 'Existing parser', value },
      { n: 2, label: 'No', value: '2' }
    ]
    expect(() => selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, actor)).toThrow(
      'no single verified key'
    )
    expect(selectSessionAnswer(prompt, { kind: 'choose', choice: 2 }, actor).value).toBe('2')
  })

  // MAJOR-2-B: any clipped label may be a persistent option cut down; only --deny proceeds.
  it('refuses --allow when any other option is clipped, and still denies', async () => {
    const prompt = permission()
    prompt.options = [
      { n: 1, label: "Yes, and don't ask again for git st…", value: 'allowForSession' },
      ...prompt.options.slice(1)
    ]
    const { deps, run } = setup(prompt)
    await expect(run({ kind: 'allow' })).rejects.toThrow('cannot be read completely')
    expect(deps.deliver).not.toHaveBeenCalled()
    await expect(run({ kind: 'deny' })).resolves.toMatchObject({ chosen: { label: 'Deny' } })
  })

  // MAJOR-2: the fingerprint binds what would be sent, not just what is shown.
  it('refuses a question whose option keys changed under the same labels', async () => {
    const listed = question('Prod')
    const current = question('Prod')
    current.options = [
      { n: 1, label: 'Prod', value: 'q1:choice-2' },
      { n: 2, label: 'No', value: 'q1:choice-1' }
    ]
    current.ask = describeSessionPrompt('question', 'Which implementation?', current.options, true)
    const { deps, run } = setup(current)
    await expect(
      run({ kind: 'choose', choice: 1 }, { expect: listed.ask.fingerprint })
    ).rejects.toThrow('fingerprint mismatch')
    expect(deps.deliver).not.toHaveBeenCalled()
  })
})

describe('session answer: hard stops on every surface', () => {
  // MAJOR-4: the agent's full command is classified on its own, not only the prompt text.
  it('refuses --allow when only the reported command names a hard stop, and still denies', async () => {
    const { deps, run } = setup(permission('Bash\ngit status', ['git push --force origin main']))
    await expect(run({ kind: 'allow' })).rejects.toThrow('hard stop')
    expect(deps.deliver).not.toHaveBeenCalled()
    await expect(run({ kind: 'deny' })).resolves.toMatchObject({ chosen: { label: 'Deny' } })
  })

  it('refuses a choice, a reply or an allow that raises an ad budget', async () => {
    const raise = 'Raise the SD25 daily budget to $300'
    await expect(setup(question(raise)).run({ kind: 'choose', choice: 1 })).rejects.toThrow(
      'hard stop: ad-spend'
    )
    const { deps, run } = setup(question())
    await expect(run({ kind: 'text', text: raise })).rejects.toThrow('hard stop: ad-spend')
    await expect(
      setup(permission('Bash\nmeta-ads update --adset 4', [raise])).run({ kind: 'allow' })
    ).rejects.toThrow('hard stop: ad-spend')
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it('lets an ad pause through by default, and refuses it when the person asks first', () => {
    const pause = question('Pause ad set 4 in SD25')
    const target = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1' }
    const choose = { kind: 'choose' as const, choice: 1 }
    expect(selectSessionAnswer(pause, choose, actor, target)).toMatchObject({ n: 1 })
    setNextStepSuggestionService({
      deps: { settings: () => ({ enabled: true, adPauses: 'ask-first' }) }
    } as never)
    try {
      expect(() => selectSessionAnswer(pause, choose, actor, target)).toThrow('hard stop: ad-pause')
    } finally {
      setNextStepSuggestionService(null)
    }
  })

  it('refuses a question choice when its command text names a hard stop', () => {
    const prompt = question()
    prompt.commandText = ['Deploy to production']
    expect(() => selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, actor)).toThrow(
      'hard stop'
    )
  })

  // MINOR-3: the local supplement names merges and history rewrites itself.
  it.each([
    'gh pr merge 12 --squash',
    'git reset --hard HEAD~1',
    'git rebase -i HEAD~3',
    'git filter-repo --path secrets',
    'git filter-branch --tree-filter x',
    'git push --force',
    'git push -f origin feature',
    'git push --force-with-lease origin feature'
  ])('the local supplement refuses %s', (command) => {
    expect(answerHardStop(command)).toBe(true)
  })

  it.each(['git status --short', 'pwd', 'ls -la', 'git log --oneline'])(
    'the local supplement leaves %s alone',
    (command) => {
      expect(answerHardStop(command)).toBe(false)
    }
  )
})

describe('session answer: locality', () => {
  it.each(['ssh:box', 'runtime:paired-console', null])(
    'refuses a %s target for --allow, --deny and a dry run before anything changes',
    async (hostId) => {
      const { entry, deps, run } = setup()
      entry.hostId = hostId
      for (const [answer, dryRun] of [
        [{ kind: 'allow' }, false],
        [{ kind: 'deny' }, false],
        [{ kind: 'deny' }, true]
      ] as const) {
        await expect(run(answer, { dryRun })).rejects.toThrow('not on this computer')
      }
      expect(deps.stopKeepGoing).not.toHaveBeenCalled()
      expect(deps.deliver).not.toHaveBeenCalled()
    }
  )
})

describe('session answer: positive awaiting-user evidence', () => {
  it.each(['none', 'last-report', 'process'] as const)(
    'refuses a prompt whose state rests on %s, even for --deny',
    async (basis) => {
      const { entry, deps, run } = setup()
      entry.stateBasis = basis
      await expect(run({ kind: 'deny' })).rejects.toThrow('not proven to be waiting')
      expect(deps.deliver).not.toHaveBeenCalled()
    }
  )

  it.each(['hook', 'title', 'screen', 'chat-host'] as const)(
    'answers on %s evidence',
    async (basis) => {
      const { entry, run } = setup()
      entry.stateBasis = basis
      await expect(run({ kind: 'deny' })).resolves.toMatchObject({ chosen: { label: 'Deny' } })
    }
  )
})

describe('session answer: one-time allow allowlist', () => {
  it.each([
    ['an unknown structured id', { n: 2, label: 'Allow', value: 'approve' }],
    ['a structured id with a persistent label', { n: 2, label: 'Allow always', value: 'allow' }]
  ])('refuses --allow for %s even with a one-time role', (_name, option) => {
    const prompt = permission()
    prompt.options = [
      { ...option, role: 'allow-once' },
      { n: 3, label: 'Deny', value: 'deny', role: 'deny' }
    ]
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, actor)).toThrow(
      'no unambiguous one-time allow'
    )
    expect(selectSessionAnswer(prompt, { kind: 'deny' }, actor).value).toBe('deny')
  })

  // A persistent or scoped provider id behind a one-time-looking label is never --allow.
  it.each([
    'allowForSession',
    'acceptForSession',
    'allowAlways',
    'allow_always',
    'always',
    'allow-session'
  ])(
    'refuses --allow for the structured id %s labelled "Allow", even with a one-time role',
    (value) => {
      const prompt = permission()
      prompt.options = [
        { n: 1, label: 'Allow', value, role: 'allow-once' },
        { n: 2, label: 'Deny', value: 'deny', role: 'deny' }
      ]
      expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, actor)).toThrow(
        'no unambiguous one-time allow'
      )
      expect(selectSessionAnswer(prompt, { kind: 'deny' }, actor).value).toBe('deny')
    }
  )

  it('refuses an unknown deny id', () => {
    const prompt = permission()
    prompt.options = [{ n: 1, label: 'Stop', value: 'cancel', role: 'deny' }]
    expect(() => selectSessionAnswer(prompt, { kind: 'deny' }, actor)).toThrow(
      'no unambiguous deny/no'
    )
  })

  it('picks only the known Claude screen label with its own digit', () => {
    const prompt = screenPermission()
    expect(selectSessionAnswer(prompt, { kind: 'allow' }, actor)).toMatchObject({
      n: 1,
      value: '1'
    })
    expect(selectSessionAnswer(prompt, { kind: 'deny' }, actor)).toMatchObject({
      n: 3,
      value: '\x1b'
    })
    for (const option of [
      { n: 1, label: 'Sure', value: '1' },
      { n: 1, label: 'Yes', value: '2' },
      { n: 1, label: 'Yes', value: '1\r' }
    ]) {
      const altered = screenPermission()
      altered.options = [{ ...option, role: 'allow-once' }, altered.options[2]!]
      expect(() => selectSessionAnswer(altered, { kind: 'allow' }, actor)).toThrow(
        'no unambiguous one-time allow'
      )
    }
  })
})

describe('session answer: terminal agent identity', () => {
  it('passes the proven agent process to the preflight and the write', async () => {
    const { deps, run, reading } = setup(screenPermission())
    await expect(run({ kind: 'allow' })).resolves.toMatchObject({ chosen: { n: 1, label: 'Yes' } })
    expect(deps.preflight).toHaveBeenCalledWith(
      expect.anything(),
      reading.agentProcess,
      expect.objectContaining({ value: '1' })
    )
    expect(deps.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.stopKeepGoing.mock.invocationCallOrder[0]!
    )
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ value: '1' }),
      actor,
      reading.agentProcess
    )
  })

  it.each([
    ['no process proof', (r: ReturnType<typeof setup>['reading']) => (r.agentProcess = null)],
    [
      'a shell or another program in the foreground',
      (r: ReturnType<typeof setup>['reading']) => (r.entry.agentForeground = false)
    ],
    [
      'an unreadable foreground',
      (r: ReturnType<typeof setup>['reading']) => (r.entry.agentForeground = null)
    ],
    [
      'a proof for another terminal',
      (r: ReturnType<typeof setup>['reading']) =>
        (r.agentProcess = agentProcess({ ptyId: 'pty-other' }))
    ],
    [
      'a chat row with a terminal prompt',
      (r: ReturnType<typeof setup>['reading']) => (r.entry.kind = 'chat')
    ]
  ])('refuses a terminal answer with %s, even --deny', async (_name, mutate) => {
    const { deps, run, reading } = setup(screenPermission())
    mutate(reading)
    await expect(run({ kind: 'deny' })).rejects.toThrow('Nothing was sent')
    expect(deps.preflight).not.toHaveBeenCalled()
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it('refuses a structured prompt on a terminal row', async () => {
    const { deps, run, reading } = setup()
    reading.entry.kind = 'terminal'
    await expect(run({ kind: 'deny' })).rejects.toThrow('does not belong to this chat')
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it('refuses before Keep going changes when the preflight proof fails', async () => {
    const { deps, run } = setup(screenPermission())
    deps.preflight.mockRejectedValue(new SessionManageRefusal('Agent replaced. Nothing was sent.'))
    await expect(run({ kind: 'allow' })).rejects.toThrow('Agent replaced')
    expect(deps.stopKeepGoing).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })
})

describe('session answer: partial failures', () => {
  it('reports a write refused after Keep going was turned off as partial', async () => {
    const { deps, run } = setup(screenPermission())
    deps.deliver.mockRejectedValue(new SessionManageRefusal('Agent replaced. Nothing was sent.'))
    const failure = await run({ kind: 'allow' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionManagePartialError)
    expect(failure).toMatchObject({ applied: 'its Keep going was turned off' })
    expect((failure as Error).message).toContain('Agent replaced')
  })

  it('keeps a plain refusal when Keep going was already off', async () => {
    const { deps, run } = setup(screenPermission())
    deps.stopKeepGoing.mockReturnValue(false)
    deps.deliver.mockRejectedValue(new SessionManageRefusal('Agent replaced. Nothing was sent.'))
    const failure = await run({ kind: 'allow' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionManageRefusal)
    expect(failure).not.toBeInstanceOf(SessionManagePartialError)
  })
})
