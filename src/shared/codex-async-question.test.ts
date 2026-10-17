import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { normalizeCodexEvent } from './agent-hook-listener/providers/codex-events'
import { dismissCodexAsyncQuestions } from './agent-hook-listener/providers/codex-async-ask-tracking'
import { reconcileRemoteCodexState } from './agent-hook-listener/providers/codex-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from './agent-status-types'
import {
  asyncAskQuestionsLeftOut,
  formatAsyncAskAnswer,
  parseAskFromStatus
} from './native-chat-ask'
import { parseAsyncQuestionDismissal } from './codex-async-question-dismissal'
import { pendingSessionAsk } from './session-questions'
import { shouldStepNativeChatAskAnswer } from './native-chat-agent-support'
import { addCodexAsyncAsk, remainingAfterCodexTranscript } from './codex-async-question'

/** A Codex rollout the test appends to the way Codex does, one JSON line per record. */
function rollout() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-async-'))
  const path = join(dir, 'rollout.jsonl')
  writeFileSync(path, '')
  const line = (record: unknown) => appendFileSync(path, `${JSON.stringify(record)}\n`)
  return {
    path,
    /** A user message as both records Codex writes for it. */
    user: (text: string) => {
      line({ type: 'event_msg', payload: { type: 'user_message', message: text } })
      line({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
      })
    },
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}

// Real Codex 0.157.1 tool input: `request_user_input_async` returns {"accepted":true} at once.
const INPUT = {
  questions: [
    { title: 'Which color do you prefer?', options: ['Red', 'Green', 'Blue'] },
    { title: 'Anything else?' }
  ]
}

function reply(index: number, answer: string): string {
  const id = JSON.stringify(['request_user_input_async', 'call_1', index])
  return `<send_user_message_question_reply>\n${JSON.stringify([
    { answer, question: INPUT.questions[index]!.title, questionItemId: id }
  ])}\n</send_user_message_question_reply>`
}

describe('Codex request_user_input_async', () => {
  let state: HookListenerState
  const send = (payload: Record<string, unknown>) =>
    normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')!.payload
  const openQuestions = () =>
    pendingSessionAsk(send({ hook_event_name: 'Stop' }))?.questions.map((q) => q.question) ?? []

  beforeEach(() => {
    state = createHookListenerState()
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'ask me' })
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_use_id: 'call_1'
    })
    send({
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_response: '{"accepted":true}',
      tool_use_id: 'call_1'
    })
  })

  it('stays in Codex’s own UI mid-turn and rides the finished turn once it ends', () => {
    const shell = send({
      hook_event_name: 'PreToolUse',
      tool_name: 'exec_command',
      tool_input: { cmd: 'ls' }
    })
    expect(shell.state).toBe('working')
    expect(shell.interactivePrompt).toBeUndefined()

    const stop = send({ hook_event_name: 'Stop', last_assistant_message: 'Asked.' })
    // Why done: Codex idles at its composer; a paused state would read its prose as a key menu.
    expect(stop.state).toBe('done')
    const ask = pendingSessionAsk(stop)
    expect(ask?.delivery).toBe('async')
    expect(ask?.questions.map((q) => q.question)).toEqual([
      'Which color do you prefer?',
      'Anything else?'
    ])
    expect(ask?.questions[0]!.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue'])
  })

  it("drops only the questions Codex's own reply block answers", () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: reply(0, 'Blue') })
    expect(openQuestions()).toEqual(['Anything else?'])
    send({ hook_event_name: 'UserPromptSubmit', prompt: reply(1, 'No') })
    expect(openQuestions()).toEqual([])
  })

  it('drops only the question an OmniConsole answer quotes', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: '> Which color do you prefer?\n\nBlue' })
    expect(openQuestions()).toEqual(['Anything else?'])
  })

  it('keeps an earlier question when Codex asks another before either is answered', () => {
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: { questions: [{ title: 'Which region?', options: ['EU', 'US'] }] },
      tool_use_id: 'call_2'
    })
    expect(openQuestions()).toEqual([
      'Which color do you prefer?',
      'Anything else?',
      'Which region?'
    ])
  })

  it("drops a question Codex's reply block names by text even when its call id differs", () => {
    send({
      hook_event_name: 'UserPromptSubmit',
      prompt: reply(0, 'Blue').replace('call_1', 'call_other')
    })
    expect(openQuestions()).toEqual(['Anything else?'])
  })

  it('keeps every question when a reply block names none of them', () => {
    send({
      hook_event_name: 'UserPromptSubmit',
      prompt:
        '<send_user_message_question_reply>[{"answer":"x","questionItemId":"not json"}]</send_user_message_question_reply>'
    })
    expect(openQuestions()).toHaveLength(2)
  })

  it('drops the questions of a call Codex did not accept', () => {
    send({
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_response: '{"accepted":false}',
      tool_use_id: 'call_1'
    })
    expect(openQuestions()).toEqual([])
    expect(send({ hook_event_name: 'Stop' }).interactivePrompt).toBeUndefined()
  })

  it('is invisible to a client that only knows selector questions', () => {
    const stop = send({ hook_event_name: 'Stop' })
    expect(JSON.parse(stop.interactivePrompt!)).not.toHaveProperty('questions')
  })

  // Why: Codex clears its own open questions on every ordinary prompt, a steer included, and the
  // agent takes that message (the person's or another session's) as the reply.
  it('is not asked again at turn end after a reply typed while Codex still works', () => {
    send({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Only the advertising session on this macbook.'
    })
    send({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'ls' } })
    expect(pendingSessionAsk(send({ hook_event_name: 'Stop' }))).toBeNull()
  })

  it('clears its questions when a message arrives while the turn waits on an approval', () => {
    send({
      hook_event_name: 'PermissionRequest',
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm -rf build' }
    })
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'yes, and also check the tests' })
    expect(openQuestions()).toEqual([])
  })

  it('keeps the questions an answer typed mid-turn leaves out', () => {
    send({ hook_event_name: 'UserPromptSubmit', prompt: '> Which color do you prefer?\n\nBlue' })
    expect(openQuestions()).toEqual(['Anything else?'])
  })

  it('drops the questions a card dismissed for good, and only those', () => {
    const stop = send({ hook_event_name: 'Stop' })
    const [color, anything] = pendingSessionAsk(stop)!.questions
    const first = dismissCodexAsyncQuestions(state, PANE_KEY, stop.interactivePrompt, [color!])
    expect(parseAskFromStatus(first?.interactivePrompt)?.questions.map((q) => q.question)).toEqual([
      'Anything else?'
    ])
    expect(openQuestions()).toEqual(['Anything else?'])
    expect(dismissCodexAsyncQuestions(state, PANE_KEY, undefined, [color!])).toBeNull()
    expect(dismissCodexAsyncQuestions(state, PANE_KEY, undefined, [anything!])).toEqual({
      interactivePrompt: undefined
    })
    expect(openQuestions()).toEqual([])
  })

  it('drops a skipped question while the turn its answer started still runs', () => {
    const [, anything] = pendingSessionAsk(send({ hook_event_name: 'Stop' }))!.questions
    send({ hook_event_name: 'UserPromptSubmit', prompt: '> Which color do you prefer?\n\nBlue' })
    expect(dismissCodexAsyncQuestions(state, PANE_KEY, undefined, [anything!])).toEqual({
      interactivePrompt: undefined
    })
    expect(openQuestions()).toEqual([])
  })

  it("drops a question longer than the card keeps once Codex's reply names its full text", () => {
    const title = `Which of these? ${'x'.repeat(2_500)}`
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: { questions: [{ title }] },
      tool_use_id: 'call_long'
    })
    const block = JSON.stringify([
      { answer: 'x', question: title, questionItemId: '["request_user_input_async","other",0]' }
    ])
    send({
      hook_event_name: 'UserPromptSubmit',
      prompt: `<send_user_message_question_reply>${block}</send_user_message_question_reply>`
    })
    expect(openQuestions()).toHaveLength(2)
  })

  it('clears when a new turn starts after the questions were left waiting, and on a new session', () => {
    send({ hook_event_name: 'Stop' })
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'Blue, thanks' })
    expect(openQuestions()).toEqual([])
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_use_id: 'call_1'
    })
    send({ hook_event_name: 'SessionStart', source: 'startup' })
    expect(openQuestions()).toEqual([])
  })

  it('never lets a transcript drop a question asked without a transcript mark', () => {
    const log = rollout()
    try {
      log.user(reply(0, 'Blue'))
      const stop = send({ hook_event_name: 'Stop', transcript_path: log.path })
      expect(pendingSessionAsk(stop)?.questions).toHaveLength(2)
    } finally {
      log.dispose()
    }
  })

  it('is answered with a message on every client, never selector keys', () => {
    const ask = pendingSessionAsk(send({ hook_event_name: 'Stop' }))!
    expect(shouldStepNativeChatAskAnswer('codex', ask)).toBe(false)
    expect(shouldStepNativeChatAskAnswer('codex')).toBe(true)
  })

  it('formats the answer the way Codex replies without an id', () => {
    const ask = pendingSessionAsk(send({ hook_event_name: 'Stop' }))!
    expect(formatAsyncAskAnswer(ask, [{ indices: [2] }, { indices: [], other: 'No' }])).toBe(
      '> Which color do you prefer?\n\nBlue\n\n> Anything else?\n\nNo'
    )
  })
})

describe('question shapes from other agents', () => {
  it("reads Kimi Code's multi_select", () => {
    const input = {
      questions: [{ question: 'Which?', options: [{ label: 'A' }], multi_select: true }]
    }
    expect(
      parseAskFromStatus(JSON.stringify(input), 'AskUserQuestion')?.questions[0]!.multiSelect
    ).toBe(true)
  })
})

describe("Codex's transcript at turn end", () => {
  let state: HookListenerState
  let log: ReturnType<typeof rollout>
  // Why transcript_path on every event: Codex sends it with each hook.
  const send = (payload: Record<string, unknown>) =>
    normalizeHookPayload(
      state,
      'codex',
      { paneKey: PANE_KEY, payload: { ...payload, transcript_path: log.path } },
      'production'
    )!.payload
  const prompt = (text: string) => {
    log.user(text)
    send({ hook_event_name: 'UserPromptSubmit', prompt: text })
  }
  const ask = (id: string, title: string, options: string[] = ['Yes', 'No']) => {
    const input = { questions: [{ title, options }] }
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: input,
      tool_use_id: id
    })
    send({
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input_async',
      tool_input: input,
      tool_response: '{"accepted":true}',
      tool_use_id: id
    })
  }
  const stop = () => send({ hook_event_name: 'Stop', last_assistant_message: 'Asked.' })
  const open = (status: ReturnType<typeof stop>) =>
    pendingSessionAsk(status)?.questions.map((q) => q.question) ?? []

  beforeEach(() => {
    state = createHookListenerState()
    log = rollout()
    send({ hook_event_name: 'SessionStart', source: 'startup' })
    return () => log.dispose()
  })

  it("drops a question answered in Codex's own box after it was asked", () => {
    prompt('ask me')
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: INPUT,
      tool_use_id: 'call_1'
    })
    log.user(reply(0, 'Blue'))
    expect(open(stop())).toEqual(['Anything else?'])
  })

  it.each(['Use the defaults and keep going.', 'Actually, inspect the logs first.'])(
    'clears questions from an ordinary transcript prompt when its submit hook was missed: %s',
    (text) => {
      prompt('ask me')
      ask('call_1', 'Which color?')
      expect(open(stop())).toEqual(['Which color?'])
      log.user(text)
      expect(open(stop())).toEqual([])
      expect(open(stop())).toEqual([])
    }
  )

  it('keeps an explicit transcript reply block that answers only another question', () => {
    prompt('ask me')
    ask('current', 'Which color?')
    log.user(reply(1, 'Something else'))
    expect(open(stop())).toEqual(['Which color?'])
  })

  it('clears only questions marked before an ordinary message in the same transcript', () => {
    const original = addCodexAsyncAsk(undefined, { questions: [{ title: 'Earlier?' }] }, 'old', {
      path: log.path,
      offset: 100
    })!
    const later = addCodexAsyncAsk(original, { questions: [{ title: 'Later?' }] }, 'new', {
      path: log.path,
      offset: 300
    })!
    const anotherPath = addCodexAsyncAsk(
      later,
      { questions: [{ title: 'Other transcript?' }] },
      'other',
      { path: `${log.path}.other`, offset: 100 }
    )!
    const unmarked = addCodexAsyncAsk(
      anotherPath,
      { questions: [{ title: 'Unmarked?' }] },
      'unmarked'
    )!
    const left = remainingAfterCodexTranscript(unmarked, log.path, [
      { text: 'Use the defaults.', offset: 200 }
    ])
    expect(left?.envelope.asyncQuestions.map((question) => question.question)).toEqual([
      'Later?',
      'Other transcript?',
      'Unmarked?'
    ])
  })

  it('keeps a question Codex asks again after the answer that started this turn', () => {
    prompt('pick a color for the banner')
    ask('c1', 'Which color?', ['Red', 'Blue'])
    const first = stop()
    const answer = formatAsyncAskAnswer(parseAskFromStatus(first.interactivePrompt)!, [
      { indices: [], other: 'Purple' }
    ])
    prompt(answer)
    // Codex: Purple is not available, and it asks the same question again.
    ask('c2', 'Which color?', ['Red', 'Blue'])
    const second = stop()
    expect(second.state).toBe('done')
    expect(open(second)).toEqual(['Which color?'])
  })

  it("keeps a new question an earlier turn's answer to the same words cannot answer", () => {
    prompt('deploy staging')
    log.user('> Proceed with the deploy?\n\nYes')
    prompt('now deploy production')
    ask('c2', 'Proceed with the deploy?')
    expect(open(stop())).toEqual(['Proceed with the deploy?'])
  })

  it("keeps a repeated question an earlier reply block named by text, not by this call's id", () => {
    prompt('deploy staging')
    const block = JSON.stringify([
      {
        answer: 'Yes',
        question: 'Proceed with the deploy?',
        questionItemId: '["request_user_input_async","c1",0]'
      }
    ])
    log.user(`<send_user_message_question_reply>${block}</send_user_message_question_reply>`)
    prompt('now deploy production')
    ask('c2', 'Proceed with the deploy?')
    expect(open(stop())).toEqual(['Proceed with the deploy?'])
  })
})

describe('Codex async questions over SSH', () => {
  it("main keeps the relay's finished turn and the questions riding it", () => {
    const relay = createHookListenerState()
    const main = createHookListenerState()
    let previous: ReturnType<typeof reconcileRemoteCodexState> | undefined
    const event = (name: string, extra: Record<string, unknown> = {}) => {
      const published = normalizeCodexEvent(relay, name, '', PANE_KEY, {
        hook_event_name: name,
        ...extra
      })!
      const agentId = typeof extra.agent_id === 'string' ? extra.agent_id : undefined
      previous = reconcileRemoteCodexState(main, PANE_KEY, name, agentId, published, previous)
      return { published, reconciled: previous }
    }
    event('SessionStart', { source: 'startup' })
    event('UserPromptSubmit', { prompt: 'ask me' })
    event('PreToolUse', {
      tool_name: 'request_user_input_async',
      tool_use_id: 'c1',
      tool_input: { questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] }
    })
    event('PostToolUse', {
      tool_name: 'request_user_input_async',
      tool_use_id: 'c1',
      tool_response: '{"accepted":true}'
    })
    const { published, reconciled } = event('Stop', { last_assistant_message: 'Asked.' })
    expect(published.state).toBe('done')
    expect(reconciled.state).toBe('done')
    expect(pendingSessionAsk(reconciled)?.questions.map((q) => q.question)).toEqual([
      'Which color?'
    ])

    // A child that outlives the lead's turn keeps the question on main as well.
    const child = event('SubagentStart', { agent_id: 'child-1', agent_type: 'worker' }).reconciled
    expect(child).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(pendingSessionAsk(child)?.delivery).toBe('async')
  })
})

describe('the async question envelope', () => {
  const statusFor = (questions: { title: string; options: string[] }[]) => {
    const state = createHookListenerState()
    const send = (payload: Record<string, unknown>) =>
      normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')!.payload
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'ask me' })
    send({
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input_async',
      tool_input: { questions },
      tool_use_id: 'call_big'
    })
    return send({ hook_event_name: 'Stop' })
  }

  it('fits the status prompt cap by leaving out the latest questions, never cutting the JSON', () => {
    // About 4,100 characters each: three fit the 16,000 cap, eight would be ~33,000.
    const questions = Array.from({ length: 8 }, (_, n) => ({
      title: `Question ${n} ${'q'.repeat(1_980)}`,
      options: Array.from({ length: 4 }, (_, i) => `Option ${i} ${'o'.repeat(490)}`)
    }))
    const stop = statusFor(questions)
    expect(stop.interactivePrompt!.length).toBeLessThanOrEqual(
      AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    )
    const ask = pendingSessionAsk(stop)!
    expect(ask.questions.map((q) => q.question)).toEqual(questions.slice(0, 3).map((q) => q.title))
    expect(ask.questions.every((q) => q.options.length === 4)).toBe(true)
  })

  it('drops trailing options when one question alone is over the cap', () => {
    const title = `Which? ${'"'.repeat(1_900)}`
    const stop = statusFor([
      { title, options: Array.from({ length: 32 }, (_, i) => `${i} ${'\\'.repeat(500)}`) }
    ])
    expect(stop.interactivePrompt!.length).toBeLessThanOrEqual(
      AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    )
    const ask = pendingSessionAsk(stop)!
    expect(ask.questions.map((q) => q.question)).toEqual([title])
    expect(ask.questions[0]!.options.length).toBeLessThan(32)
  })
})

describe('the lead’s async question while a child holds the pane', () => {
  it('is never offered over a child’s approval or blocking question', () => {
    const state = createHookListenerState()
    const event = (name: string, extra: Record<string, unknown> = {}) =>
      normalizeCodexEvent(state, name, '', PANE_KEY, { hook_event_name: name, ...extra })!
    const child = { agent_id: 'child-1', agent_type: 'worker' }
    event('SessionStart', { source: 'startup' })
    event('UserPromptSubmit', { prompt: 'refactor, ask me which db' })
    event('SubagentStart', child)
    event('PreToolUse', {
      tool_name: 'request_user_input_async',
      tool_use_id: 'c1',
      tool_input: { questions: [{ title: 'Which database?', options: ['Postgres', 'SQLite'] }] }
    })
    event('PostToolUse', {
      tool_name: 'request_user_input_async',
      tool_use_id: 'c1',
      tool_response: '{"accepted":true}'
    })
    // Why done: Codex can omit child Stop hooks, so the lead's Stop resets the roster; the child
    // comes back with its next event.
    const stop = event('Stop', { last_assistant_message: 'Asked; the worker keeps going.' })
    expect(pendingSessionAsk(stop)?.delivery).toBe('async')

    const approval = event('PermissionRequest', {
      ...child,
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm -rf build' }
    })
    expect(approval.state).toBe('waiting')
    expect(approval.interactivePrompt ?? '').not.toContain('asyncQuestions')
    expect(pendingSessionAsk(approval)).toBeNull()

    // The child moves on; the lead's question is the person's again.
    const resumed = event('PostToolUse', { ...child, tool_name: 'exec_command' })
    expect(resumed).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(pendingSessionAsk(resumed)?.questions.map((q) => q.question)).toEqual([
      'Which database?'
    ])

    const blocking = event('PreToolUse', {
      ...child,
      tool_name: 'request_user_input',
      tool_input: { questions: [{ question: 'Which table?', options: ['a', 'b'] }] }
    })
    expect(blocking.state).toBe('waiting')
    expect(blocking.interactivePrompt ?? '').not.toContain('asyncQuestions')
  })

  it('is not pending on a waiting row even if one carries it', () => {
    const ask = JSON.stringify({
      delivery: 'async',
      asyncQuestions: [{ question: 'Which database?', multiSelect: false, options: [] }]
    })
    expect(pendingSessionAsk({ state: 'waiting', interactivePrompt: ask })).toBeNull()
    expect(pendingSessionAsk({ state: 'blocked', interactivePrompt: ask })).toBeNull()
    expect(pendingSessionAsk({ state: 'done', interactivePrompt: ask })?.delivery).toBe('async')
  })
})

describe('an async question’s identity', () => {
  it('is its asking: kept while children start and finish, new when Codex asks again', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const state = createHookListenerState()
      const event = (name: string, extra: Record<string, unknown> = {}) =>
        normalizeCodexEvent(state, name, '', PANE_KEY, { hook_event_name: name, ...extra })!
      const ask = (id: string) => {
        event('PreToolUse', {
          tool_name: 'request_user_input_async',
          tool_use_id: id,
          tool_input: { questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] }
        })
        event('PostToolUse', {
          tool_name: 'request_user_input_async',
          tool_use_id: id,
          tool_response: '{"accepted":true}'
        })
      }
      const askedAt = (status: ReturnType<typeof event>) =>
        pendingSessionAsk(status)?.questions[0]?.askedAt
      event('UserPromptSubmit', { prompt: 'pick a color' })
      ask('c1')
      vi.setSystemTime(20_000)
      const stop = event('Stop')
      expect(askedAt(stop)).toBe(10_000)
      vi.setSystemTime(30_000)
      const monitoring = event('SubagentStart', { agent_id: 'child-1', agent_type: 'worker' })
      expect(monitoring).toMatchObject({ state: 'working', workingMode: 'monitoring' })
      expect(askedAt(monitoring)).toBe(10_000)
      event('UserPromptSubmit', { prompt: '> Which color?\n\nPurple' })
      vi.setSystemTime(40_000)
      ask('c2')
      expect(askedAt(event('Stop'))).toBe(40_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('dismissing an async question', () => {
  const ROW = JSON.stringify({
    delivery: 'async',
    asyncQuestions: [
      { question: 'Which color?', multiSelect: false, options: [], askedAt: 5 },
      { question: 'Which size?', multiSelect: false, options: [], askedAt: 6 }
    ]
  })

  it('drops it from a row restored from disk, whose asking was never heard here', () => {
    const state = createHookListenerState()
    expect(
      dismissCodexAsyncQuestions(state, PANE_KEY, ROW, [{ question: 'Which color?', askedAt: 5 }])
    ).toEqual({
      interactivePrompt: JSON.stringify({
        delivery: 'async',
        asyncQuestions: [{ question: 'Which size?', multiSelect: false, options: [], askedAt: 6 }]
      })
    })
    expect(state.codexAsyncAskByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('keeps the same words asked again after the asking the card showed', () => {
    const state = createHookListenerState()
    expect(
      dismissCodexAsyncQuestions(state, PANE_KEY, ROW, [{ question: 'Which color?', askedAt: 4 }])
    ).toBeNull()
    expect(
      dismissCodexAsyncQuestions(state, PANE_KEY, undefined, [{ question: 'Which color?' }])
    ).toBeNull()
  })

  it('names the questions a card answer leaves out', () => {
    const ask = parseAskFromStatus(ROW)!
    expect(
      asyncAskQuestionsLeftOut(ask, [{ indices: [], other: 'Red' }, { indices: [] }]).map(
        (question) => question.question
      )
    ).toEqual(['Which size?'])
  })

  it('accepts only a well-formed request from the window', () => {
    expect(
      parseAsyncQuestionDismissal({ paneKey: PANE_KEY, questions: [{ question: 'Q', askedAt: 1 }] })
    ).toEqual({ paneKey: PANE_KEY, questions: [{ question: 'Q', askedAt: 1 }] })
    expect(parseAsyncQuestionDismissal({ paneKey: PANE_KEY, questions: [] })).toBeNull()
    expect(
      parseAsyncQuestionDismissal({ paneKey: PANE_KEY, questions: [{ question: 1 }] })
    ).toBeNull()
    expect(
      parseAsyncQuestionDismissal({
        paneKey: PANE_KEY,
        questions: [{ question: 'Q', askedAt: 'x' }]
      })
    ).toBeNull()
    expect(parseAsyncQuestionDismissal(null)).toBeNull()
  })
})
