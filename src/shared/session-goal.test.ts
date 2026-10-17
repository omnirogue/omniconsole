import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  compactSessionContext,
  publishedSessionContext,
  sessionContextForHover
} from './session-compact-context'
import {
  firstSessionGoalInMessages,
  SESSION_GOAL_LINE_MAX,
  sessionGoalFromPrompt
} from './session-goal'

function user(text: string): NativeChatMessage {
  return {
    id: text,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('sessionGoalFromPrompt', () => {
  it('clears cached progress for a repeated request before the throttled transcript catches up', () => {
    for (const prompt of ['continue', 'a'.repeat(500)]) {
      const context = compactSessionContext(
        [user(prompt), { ...user('Finished the old turn'), role: 'assistant' }],
        sessionGoalFromPrompt('Improve descriptions')
      )
      context.nextStep = 'Old next step'
      const entry = { prompt, updatedAt: 3_000, state: 'working' as const, stateStartedAt: 2_000 }
      expect(sessionContextForHover(context, 1_000, entry)).toEqual({
        ...context,
        latestUpdate: null,
        nextStep: null
      })
      // Once the transcript includes the current turn, live tool pings keep its progress.
      expect(sessionContextForHover(context, 2_500, entry)).toBe(context)
    }
  })

  it('clears an earlier answer and plan when the person changes the request', () => {
    const answer: NativeChatMessage = {
      ...user(
        'Finished the first task.\n- [x] Implement the old change\n- [ ] Deploy the old change'
      ),
      role: 'assistant'
    }
    const context = compactSessionContext(
      [user('Fix checkout'), answer, user('Now improve the session hover')],
      sessionGoalFromPrompt('Fix checkout')
    )
    expect(context).toEqual({
      goal: 'Fix checkout',
      latestRequest: 'Now improve the session hover',
      latestUpdate: null,
      nextStep: null
    })
  })

  it('keeps genuine progress through harness records and ignores a peer exchange', () => {
    const update: NativeChatMessage = {
      ...user('Added the hover description.\n- [x] Build the hover\n- [ ] Check automatic names'),
      role: 'assistant'
    }
    const messages = [
      user('Improve session descriptions'),
      update,
      user('# AGENTS.md instructions for /repo\nFollow the rules'),
      { ...user('private reasoning'), role: 'reasoning' as const },
      user('[Question q-1234abcd from Another session — answer only, change nothing] Is it ready?'),
      { ...user('Yes, the other work is done.'), role: 'assistant' as const }
    ]
    expect(compactSessionContext(messages)).toEqual({
      goal: null,
      latestRequest: 'Improve session descriptions',
      latestUpdate:
        'Added the hover description. - [x] Build the hover - [ ] Check automatic names',
      nextStep: 'Check automatic names'
    })
  })

  it('reads a current plan without showing tool output as the latest update', () => {
    const plan: NativeChatMessage = {
      ...user(''),
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'update_plan',
          input: {
            plan: [
              { step: 'Later', status: 'pending' },
              { step: 'Check hover rendering', status: 'in_progress' }
            ]
          }
        }
      ]
    }
    const context = compactSessionContext([
      user('Improve hovers'),
      plan,
      {
        ...user('secret tool output'),
        role: 'tool'
      }
    ])
    expect(context.nextStep).toBe('Check hover rendering')
    expect(context.latestUpdate).toBeNull()
  })

  it('bounds hover text and uses only host-published assistant prose for remote sessions', () => {
    const context = compactSessionContext(
      [user('a'.repeat(3_000)), { ...user('b'.repeat(3_000)), role: 'assistant' }],
      sessionGoalFromPrompt('c'.repeat(3_000))
    )
    expect(context.goal?.length).toBeLessThanOrEqual(240)
    expect(context.latestRequest?.length).toBeLessThanOrEqual(240)
    expect(context.latestUpdate?.length).toBeLessThanOrEqual(360)
    expect(
      publishedSessionContext({
        prompt: 'Check remote rendering',
        lastAssistantMessage: 'tool payload',
        lastAssistantMessageIsToolOutput: true
      })
    ).toEqual({
      goal: null,
      latestRequest: 'Check remote rendering',
      latestUpdate: null,
      nextStep: null
    })
    expect(
      publishedSessionContext({
        prompt: '[from Session steward] Read this machine task',
        lastAssistantMessage: 'Done'
      }).latestUpdate
    ).toBeNull()
  })

  it('collapses the prompt to one line and keeps the full text', () => {
    expect(sessionGoalFromPrompt('  Fix the login bug\n\non the settings page ')).toEqual({
      line: 'Fix the login bug on the settings page',
      full: 'Fix the login bug\n\non the settings page'
    })
  })

  it('reads the actual request beyond launcher context before bounding the goal', () => {
    const prompt =
      `# Launch context (added by omni-launch-best; estate context)\n\n${'Company and domain context.\n'.repeat(
        400
      )}Start here: \`slite-kb brief --scope shared --division ops\` for this company and department, and \`wis knowledge search --q "<task terms>"\` for estate history.\n\n` +
      `[Image #1] Fix keyboard delivery`
    expect(sessionGoalFromPrompt(prompt)).toEqual({
      line: 'Fix keyboard delivery',
      full: 'Fix keyboard delivery'
    })
  })

  it('truncates a long prompt to one bounded line', () => {
    const goal = sessionGoalFromPrompt('word '.repeat(100))
    expect(goal?.line.length).toBe(SESSION_GOAL_LINE_MAX)
    expect(goal?.line.endsWith('…')).toBe(true)
  })

  it('rejects harness-injected turns', () => {
    expect(sessionGoalFromPrompt('<system-reminder>be nice</system-reminder>')).toBeNull()
    expect(sessionGoalFromPrompt('<task-notification>done</task-notification>')).toBeNull()
    expect(sessionGoalFromPrompt('[Request interrupted by user]')).toBeNull()
    expect(sessionGoalFromPrompt('   ')).toBeNull()
    expect(sessionGoalFromPrompt(null)).toBeNull()
  })

  it('strips harness blocks embedded after the real ask but keeps unknown tags', () => {
    expect(
      sessionGoalFromPrompt('Ship the report\n<system-reminder>internal</system-reminder>')?.line
    ).toBe('Ship the report')
    expect(sessionGoalFromPrompt('Render <my-card>hi</my-card> nicely')?.line).toBe(
      'Render <my-card>hi</my-card> nicely'
    )
  })

  it('drops pasted-text markers and code blocks from the line', () => {
    expect(
      sessionGoalFromPrompt('Why does this fail? [Pasted text #1 +40 lines]\n```\nstack\n```')?.line
    ).toBe('Why does this fail?')
  })

  it('skips provider context records written as user turns', () => {
    expect(sessionGoalFromPrompt('# AGENTS.md instructions for /repo\n\nBe terse.')).toBeNull()
    expect(
      sessionGoalFromPrompt('<environment_context>\n<cwd>/repo</cwd>\n</environment_context>')
    ).toBeNull()
  })

  it('has no goal when the prompt is only a paste', () => {
    expect(sessionGoalFromPrompt('```\nconst a = 1\n```')).toBeNull()
  })
})

describe('firstSessionGoalInMessages', () => {
  it('skips injected turns and non-user messages to the first real ask', () => {
    const messages: NativeChatMessage[] = [
      user('<local-command-caveat>Caveat</local-command-caveat>'),
      {
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Hi' }],
        timestamp: null,
        source: 'transcript'
      },
      user('Build the goals view'),
      user('Also add tests')
    ]
    expect(firstSessionGoalInMessages(messages)?.line).toBe('Build the goals view')
  })

  it('returns null when no genuine prompt exists', () => {
    expect(firstSessionGoalInMessages([user('<system-reminder>x</system-reminder>')])).toBeNull()
  })
})
