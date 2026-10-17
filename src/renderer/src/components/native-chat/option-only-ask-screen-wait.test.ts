import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AskPrompt } from './native-chat-interactive-prompt'
import {
  OPTION_ONLY_ASK_SCREEN_POLL_MS,
  OPTION_ONLY_ASK_SCREEN_WAIT_MS,
  waitForOptionOnlyAskStep
} from './option-only-ask-screen-wait'

const capture = (name: string): string =>
  readFileSync(
    join(__dirname, '../../../../shared/__fixtures__/option-only-ask-screens', `${name}.txt`),
    'utf8'
  )
// Live captures: question 1 of a Qwen batch, then the tab after its digit landed.
const QWEN_BATCH = capture('qwen-batch')
const QWEN_SECOND_TAB = capture('qwen-batch-second')
const PROMPT: AskPrompt = {
  questions: ['Which fruit?', 'Which ocean?'].map((question, index) => ({
    question,
    header: ['Fruit', 'Ocean'][index],
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }]
  }))
}

function clock() {
  let time = 0
  return { now: () => time, sleep: async (ms: number) => void (time += ms) }
}

describe('waitForOptionOnlyAskStep', () => {
  it('waits for a Qwen tab advance before the next question’s key', async () => {
    const { now, sleep } = clock()
    let reads = 0
    const readScreen = () => (++reads < 4 ? QWEN_BATCH : QWEN_SECOND_TAB)
    const ok = await waitForOptionOnlyAskStep({
      agent: 'qwen',
      prompt: PROMPT,
      group: { raw: '1', screen: 1 },
      readScreen,
      isCancelled: () => false,
      now,
      sleep
    })
    expect(ok).toBe(true)
    expect(now()).toBe(3 * OPTION_ONLY_ASK_SCREEN_POLL_MS)
  })

  it('gives up when the tab never advances', async () => {
    const { now, sleep } = clock()
    const ok = await waitForOptionOnlyAskStep({
      agent: 'qwen',
      prompt: PROMPT,
      group: { raw: '1', screen: 1 },
      readScreen: () => QWEN_BATCH,
      isCancelled: () => false,
      now,
      sleep
    })
    expect(ok).toBe(false)
    expect(now()).toBeGreaterThanOrEqual(OPTION_ONLY_ASK_SCREEN_WAIT_MS)
  })

  it('stops on cancel and on an unreadable screen', async () => {
    const { now, sleep } = clock()
    const base = { agent: 'qwen' as const, prompt: PROMPT, now, sleep }
    await expect(
      waitForOptionOnlyAskStep({
        ...base,
        group: { raw: '2', screen: 0 },
        readScreen: () => QWEN_BATCH,
        isCancelled: () => true
      })
    ).resolves.toBe(false)
    await expect(
      waitForOptionOnlyAskStep({
        ...base,
        group: { raw: '2', screen: 0 },
        readScreen: () => {
          throw new Error('gone')
        },
        isCancelled: () => false
      })
    ).resolves.toBe(false)
  })
})
