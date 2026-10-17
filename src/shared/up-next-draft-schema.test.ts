/**
 * A Person draft's due date on the wire and on disk: one schema for both, so a due that
 * survived a restart is exactly a due that could have been sent. Drafts written before the
 * due existed stay readable; the Person block never carries a communication type.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeUpNextDraftRecord,
  upNextBlockPatchSchema,
  upNextDraftInputSchema
} from './up-next-draft-schema'

const subject = { kind: 'pty' as const, worktreeId: 'wt', paneKey: 'tab-1:leaf-1' }
const person = {
  kind: 'person' as const,
  relationship: 'handoff' as const,
  people: [{ id: 'emp_iris', name: 'Iris Allen' }]
}

function record(input: unknown) {
  return normalizeUpNextDraftRecord({
    subject,
    entries: [{ id: 'draft:p', input, createdAt: 1 }],
    updatedAt: 2
  })
}

describe('a Person draft with a due date', () => {
  it.each(['handoff', 'review'] as const)('round-trips the due of a %s', (relationship) => {
    const input = {
      ...person,
      relationship,
      receive: { transcript: true, dueAt: '2026-09-20T23:59:59-04:00' }
    }
    expect(record(input)?.entries[0]?.input).toEqual(input)
    expect(upNextDraftInputSchema.parse(input)).toEqual(input)
  })

  it('keeps reading a draft written before the due existed', () => {
    const old = { ...person, receive: { files: true, note: 'Only the signing matters.' } }
    const read = record(old)
    expect(read?.entries).toHaveLength(1)
    expect(read?.entries[0]?.input).toEqual(old)
    expect(record(person)?.entries[0]?.input).toEqual(person)
  })

  it('accepts a due only with an offset and whole seconds', () => {
    for (const dueAt of ['2026-09-20T23:59:59Z', '2026-09-20T15:30:00+05:30']) {
      expect(upNextDraftInputSchema.safeParse({ ...person, receive: { dueAt } }).success).toBe(true)
    }
    for (const dueAt of ['2026-09-20T23:59:59.000Z', '2026-09-20T23:59:59', '2026-09-20', '']) {
      expect(upNextDraftInputSchema.safeParse({ ...person, receive: { dueAt } }).success).toBe(
        false
      )
    }
  })

  it('lets an edit set or clear the due through the whole receive object', () => {
    const set = { kind: 'person', receive: { files: true, dueAt: '2026-09-21T09:00:00+02:00' } }
    expect(upNextBlockPatchSchema.parse(set)).toEqual(set)
    const cleared = { kind: 'person', receive: { files: true } }
    expect(upNextBlockPatchSchema.parse(cleared)).toEqual(cleared)
  })

  it('carries no communication type anywhere in the Person block', () => {
    expect(
      upNextDraftInputSchema.safeParse({ ...person, communicationType: 'information' }).success
    ).toBe(false)
    expect(
      upNextDraftInputSchema.safeParse({
        ...person,
        receive: { communicationType: 'information' }
      }).success
    ).toBe(false)
    expect(
      upNextBlockPatchSchema.safeParse({ kind: 'person', communicationType: 'request' }).success
    ).toBe(false)
  })
})
