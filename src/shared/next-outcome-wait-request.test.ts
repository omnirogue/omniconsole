import { describe, expect, it } from 'vitest'
import {
  nextOutcomeWaitRequests,
  resolveNextOutcomeWaits,
  signinAppKey
} from './next-outcome-wait-request'

const roster = [
  { id: 'emp_uma', name: 'Uma Demir' },
  { id: 'emp_iris', name: 'Iris Khan' }
]

describe('nextOutcomeWaitRequests', () => {
  it('reads two approvers and the channel from Sal’s Slack example', () => {
    expect(
      nextOutcomeWaitRequests(
        "Wait for Uma and Iris to approve on Slack, then upgrade Iris's account, then close this session"
      )
    ).toEqual([
      {
        instruction: 'Wait for Uma and Iris to approve on Slack',
        kind: 'person',
        people: ['Uma', 'Iris'],
        source: 'slack',
        match: 'approve'
      }
    ])
  })

  it('carries the Jira key', () => {
    expect(
      nextOutcomeWaitRequests('Wait for Uma to approve OMR-12 on Jira, then merge')[0]
    ).toMatchObject({
      kind: 'person',
      people: ['Uma'],
      source: 'jira',
      match: 'approve',
      ref: 'OMR-12'
    })
  })

  it('reads a sign-in and maps the app name people use to its key', () => {
    expect(nextOutcomeWaitRequests('When Iris signs in to omnios, tell me')[0]).toMatchObject({
      kind: 'signin',
      people: ['Iris'],
      source: 'signin',
      ref: 'omniconsole'
    })
    expect(signinAppKey('OmniRogue')).toBe('omnirogue')
  })

  it('reads an email reply from an address', () => {
    expect(
      nextOutcomeWaitRequests('Wait for a reply from uma@example.com, then send the summary')[0]
    ).toMatchObject({
      kind: 'person',
      people: ['uma@example.com'],
      source: 'email',
      match: 'reply'
    })
  })

  it('reads times, deadlines and pull requests', () => {
    expect(nextOutcomeWaitRequests('Wait 2 minutes, then tell me the time')[0]).toMatchObject({
      kind: 'time',
      source: 'time'
    })
    expect(nextOutcomeWaitRequests('If no answer by Friday, ask me')[0]).toMatchObject({
      kind: 'deadline'
    })
    expect(
      nextOutcomeWaitRequests(
        'Wait for https://github.com/omnirogue/omni-ide/pull/700 to merge, then close this session'
      )[0]
    ).toMatchObject({
      kind: 'github',
      match: 'merged',
      ref: 'https://github.com/omnirogue/omni-ide/pull/700'
    })
  })

  it("reads a wait for another session's result, even worded with until", () => {
    for (const prompt of [
      'Wait for the billing session to finish, then tell me what it did',
      'Once session tab-2:leaf-2 is done, merge the PR',
      'Wait until the Stripe refactor session finishes'
    ]) {
      expect(nextOutcomeWaitRequests(prompt)).toEqual([
        expect.objectContaining({ kind: 'session', source: 'session', match: 'result', people: [] })
      ])
    }
    expect(nextOutcomeWaitRequests('Save this session when done')).toEqual([])
  })

  it('asks for nothing in ordinary work, quotes, fences or negations', () => {
    for (const prompt of [
      'Please review this code and fix the tests',
      '```\nwait for Uma to approve on Slack\n```',
      "Don't wait for Uma to approve on Slack, just ship it",
      '> wait for Iris to approve on Slack'
    ]) {
      expect(nextOutcomeWaitRequests(prompt)).toEqual([])
    }
  })
})

describe('resolveNextOutcomeWaits', () => {
  it('resolves typed first names and addresses against the roster only', () => {
    const [slack] = resolveNextOutcomeWaits('Wait for Uma and Mallory to approve on Slack', roster)
    expect(slack!.persons.map((person) => person.id)).toEqual(['emp_uma'])
    expect(slack!.unresolved).toEqual(['Mallory'])
    const [mail] = resolveNextOutcomeWaits('Wait for a reply from iris@example.com', roster)
    expect(mail!.persons.map((person) => person.id)).toEqual(['emp_iris'])
  })
})
