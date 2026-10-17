import { expect, it } from 'vitest'
import { outcomeFinishLabel } from './next-step-summary'

it('reads every finish that comes back to me as Back to me', () => {
  expect(outcomeFinishLabel({ kind: 'complete' })).toBe('Back to me')
  expect(outcomeFinishLabel({ kind: 'my-review' })).toBe('Back to me')
  expect(outcomeFinishLabel(null)).toBe('Back to me')
})

it('names the teammate a Team finish hands the work to', () => {
  expect(
    outcomeFinishLabel({
      kind: 'person',
      personId: 'josh',
      personName: 'Josh',
      action: 'review',
      disposition: 'ownership'
    })
  ).toBe('Hand off to Josh')
  expect(
    outcomeFinishLabel({
      kind: 'person',
      personId: '',
      personName: '',
      action: 'review',
      disposition: 'ownership'
    })
  ).toBe('Choose who receives it')
})

it('keeps describing a legacy GitHub finish by its action and repository', () => {
  expect(
    outcomeFinishLabel({ kind: 'github', action: 'merge-and-deploy', repository: 'owner/repo' })
  ).toBe('Merge & deploy · owner/repo')
  expect(outcomeFinishLabel({ kind: 'github', action: 'create-pr' })).toBe('Create PR')
})

it('says a feedback finish comes back rather than calling it a handoff', () => {
  expect(
    outcomeFinishLabel({
      kind: 'person',
      personId: 'josh',
      personName: 'Josh',
      action: 'review',
      disposition: 'feedback'
    })
  ).toBe('Send to Josh for review')
})
