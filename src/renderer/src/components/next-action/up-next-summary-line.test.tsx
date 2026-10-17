// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpNextPromptBlock, UpNextView } from '../../../../shared/up-next-types'
import { UpNextSummaryLine } from './up-next-summary-line'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const prompt = (over: Partial<UpNextPromptBlock>): UpNextPromptBlock => ({
  id: 'pq:e2',
  kind: 'prompt',
  state: 'queued',
  number: '',
  locked: false,
  text: 'Now plan it',
  target: { kind: 'current' },
  when: 'after',
  queueEntryId: 'e2',
  ...over
})

const view = (blocks: UpNextPromptBlock[]): UpNextView =>
  ({
    header: { state: 'idle' },
    blocks,
    summary: {
      stages: 0,
      executions: 0,
      perStage: [],
      prompts: 1,
      people: 0,
      maxConcurrency: 1,
      start: 'now'
    }
  }) as unknown as UpNextView

const line = () => document.querySelector('[data-up-next-summary]')!.textContent

afterEach(cleanup)

describe('the Up next summary line', () => {
  it('says the queue is paused behind a failed prompt, not that it starts now', () => {
    render(
      <UpNextSummaryLine
        view={view([
          prompt({ id: 'pq:e1', state: 'failed', holdsQueue: true, queueEntryId: 'e1' }),
          prompt({})
        ])}
      />
    )
    expect(line()).toBe('1 prompt · paused behind a failed prompt')
  })

  it('still starts now after a failure that holds nothing (an older host)', () => {
    render(
      <UpNextSummaryLine view={view([prompt({ id: 'pq:e1', state: 'failed' }), prompt({})])} />
    )
    expect(line()).toBe('1 prompt · starts now')
  })
})
