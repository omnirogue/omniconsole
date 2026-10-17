import { describe, expect, it } from 'vitest'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import {
  classifyMoveRefusal,
  lifecycleActionFor,
  moveRefusalMessage,
  planWorkCardMove
} from './work-kanban-move'

describe('the column a person drops a card into', () => {
  it('maps each column to the hub verb that lands a card there', () => {
    expect(lifecycleActionFor('ready', 'backlog')).toBe('backlog')
    expect(lifecycleActionFor('backlog', 'ready')).toBe('ready')
    expect(lifecycleActionFor('ready', 'in-progress')).toBe('start')
    expect(lifecycleActionFor('in-progress', 'waiting')).toBe('wait')
    expect(lifecycleActionFor('in-progress', 'review')).toBe('submit_for_review')
  })

  it('resumes a waiting card instead of starting it again', () => {
    expect(lifecycleActionFor('waiting', 'in-progress')).toBe('resume')
    expect(lifecycleActionFor('backlog', 'in-progress')).toBe('start')
  })

  it('has no verb for Done, which keeps its own gated completion path', () => {
    expect(lifecycleActionFor('review', 'done')).toBeNull()
    expect(lifecycleActionFor('waiting', 'done')).toBeNull()
  })
})

describe('Proposed as a tag change on the same move', () => {
  it('enters Proposed by tagging only, from any lane', () => {
    expect(planWorkCardMove('backlog', 'proposed')).toEqual({ setProposed: true, action: null })
    expect(planWorkCardMove('ready', 'proposed')).toEqual({ setProposed: true, action: null })
  })

  it('leaves Proposed by untagging, then runs the verb unless the card already stands there', () => {
    expect(planWorkCardMove('proposed', 'backlog', 'backlog')).toEqual({
      setProposed: false,
      action: null
    })
    // Why: a ready-standing proposal dropped on Backlog would otherwise surface in Ready.
    expect(planWorkCardMove('proposed', 'backlog', 'ready')).toEqual({
      setProposed: false,
      action: 'backlog'
    })
    expect(planWorkCardMove('proposed', 'ready', 'ready')).toEqual({
      setProposed: false,
      action: null
    })
    expect(planWorkCardMove('proposed', 'ready', 'backlog')).toEqual({
      setProposed: false,
      action: 'ready'
    })
    expect(planWorkCardMove('proposed', 'in-progress', 'ready')).toEqual({
      setProposed: false,
      action: 'start'
    })
  })

  it('keeps ordinary moves as one verb and refuses a move to the same lane', () => {
    expect(planWorkCardMove('ready', 'in-progress')).toEqual({ action: 'start' })
    expect(planWorkCardMove('ready', 'ready')).toBeNull()
    expect(planWorkCardMove('proposed', 'proposed')).toBeNull()
  })
})

const refusal = (code: string, message = 'refused', status = 409): WorkflowRequestError =>
  new WorkflowRequestError({ code, message, status })

describe('what a refusal allows', () => {
  it('keeps the card and says nothing more when the hub holds the canonical rail', () => {
    const error = refusal('canonical_lifecycle_required', 'Close the open review first.')
    expect(classifyMoveRefusal(error)).toBe('canonical-rail')
    expect(moveRefusalMessage('canonical-rail', error.message)).toBe('Close the open review first.')
  })

  it('names the other console for both provenance refusals, and never retries them', () => {
    for (const code of ['card-not-ours', 'card-ownership-unknown']) {
      expect(classifyMoveRefusal(refusal(code))).toBe('other-console')
    }
    expect(moveRefusalMessage('other-console', 'ignored')).toBe(
      'This task is managed from another console.'
    )
  })

  it('retries only explicit stale revision codes', () => {
    expect(classifyMoveRefusal(refusal('stale_snapshot'))).toBe('stale-revision')
    expect(classifyMoveRefusal(refusal('revision_conflict'))).toBe('stale-revision')
    expect(classifyMoveRefusal(refusal('task_changed'))).toBe('stale-revision')
    expect(classifyMoveRefusal(refusal('revision_required'))).toBe('stale-revision')
  })

  it.each([
    'lifecycle_conflict',
    'lifecycle_validation',
    'conflict',
    'ref_conflict',
    'title_conflict',
    'backoffice_refused'
  ])('preserves a non-stale refusal: %s', (code) => {
    expect(classifyMoveRefusal(refusal(code))).toBe('other')
  })

  it('does not invent a recovery for an unrelated failure', () => {
    expect(classifyMoveRefusal(refusal('forbidden', 'no', 403))).toBe('other')
    expect(classifyMoveRefusal(new Error('offline'))).toBe('other')
  })
})
