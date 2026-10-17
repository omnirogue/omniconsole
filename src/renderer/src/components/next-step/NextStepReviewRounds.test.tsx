// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { SESSION_OUTCOME_HOST_REVIEW_REASON } from '../../../../shared/session-outcome-host-route'
import { NextStepReviewRounds } from './NextStepReviewRounds'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))

afterEach(cleanup)

const seat = (id: string, agent: string, model: string) =>
  ({
    id,
    agent,
    model,
    prompt: 'Review',
    status: 'queued',
    review: { groupId: 'g', reviewerId: agent, round: 1, maxRounds: 1, candidateVersion: 'v' }
  }) as never

function chain(taskId?: string): SessionChain {
  return {
    steps: [seat('c', 'claude', 'sonnet'), seat('x', 'codex', 'gpt-5.6-sol')],
    reviewLoop: {
      groups: [
        {
          id: 'g',
          maxRounds: 1,
          currentRound: 1,
          status: 'blocked',
          consumedRepairKeys: [],
          rounds: [
            {
              index: 1,
              candidateVersion: 'v',
              receipts: [
                {
                  stepId: 'c',
                  reviewerId: 'claude',
                  candidateVersion: 'v',
                  recordedAt: 1,
                  status: 'findings',
                  blockingFindings: ['Tests do not run on Windows']
                },
                {
                  stepId: 'x',
                  reviewerId: 'codex',
                  candidateVersion: 'v',
                  recordedAt: 1,
                  status: 'pass',
                  blockingFindings: []
                }
              ]
            }
          ]
        }
      ]
    },
    outcomeSet: {
      continuation: { taskId },
      outcomes: [{ id: 'o', stepIds: ['c', 'x'] }]
    }
  } as unknown as SessionChain
}

it('shows each reviewer’s verdict and blocking findings per round', () => {
  render(<NextStepReviewRounds chain={chain()} />)
  expect(screen.getByText('Review round 1')).toBeInTheDocument()
  expect(screen.getByText('claude · sonnet')).toBeInTheDocument()
  expect(screen.getByText('Changes requested')).toBeInTheDocument()
  expect(screen.getByText('Tests do not run on Windows')).toBeInTheDocument()
  expect(screen.getByText('codex · gpt-5.6-sol')).toBeInTheDocument()
  expect(screen.getByText('Approved')).toBeInTheDocument()
  expect(screen.queryByText(SESSION_OUTCOME_HOST_REVIEW_REASON)).not.toBeInTheDocument()
})

it('says why a card-attached review runs on this host', () => {
  render(<NextStepReviewRounds chain={chain('btk_card')} />)
  expect(screen.getByText(SESSION_OUTCOME_HOST_REVIEW_REASON)).toBeInTheDocument()
})

it('says why a reviewer could not start and why another failed', () => {
  const seatOf = (id: string) =>
    ({
      id,
      agent: 'codex',
      model: id,
      prompt: 'Review',
      status: 'queued',
      review: { groupId: 'g', reviewerId: id, round: 1, maxRounds: 1, candidateVersion: 'v' }
    }) as never
  const blocked = {
    steps: [seatOf('refused'), seatOf('crashed')],
    outcomeSet: {
      continuation: {},
      outcomes: [{ id: 'o', stepIds: ['refused', 'crashed'] }],
      attempts: [
        {
          id: 'a1',
          actionId: 'step_refused',
          state: 'blocked',
          launchDisposition: 'not-started',
          error: 'No usable seat for grok'
        },
        { id: 'a2', actionId: 'step_crashed', state: 'blocked', error: 'Worker exited' }
      ]
    }
  } as unknown as SessionChain
  render(<NextStepReviewRounds chain={blocked} />)
  expect(screen.getByText('Could not start')).toBeInTheDocument()
  expect(screen.getByText('No usable seat for grok')).toBeInTheDocument()
  expect(screen.getByText('Could not review')).toBeInTheDocument()
  expect(screen.getByText('Worker exited')).toBeInTheDocument()
})

it('renders nothing for a plan without reviewers', () => {
  const { container } = render(<NextStepReviewRounds chain={null} />)
  expect(container).toBeEmptyDOMElement()
})
