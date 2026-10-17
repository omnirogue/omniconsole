import { describe, expect, it } from 'vitest'
import { contextualApprovalOf } from './session-manage-approval'

describe('contextualApprovalOf', () => {
  it.each([
    ['yes', { kind: 'yes', bare: true }],
    ['Go ahead.', { kind: 'yes', bare: true }],
    ['OK, do it!', { kind: 'yes', bare: true }],
    ['yes please', { kind: 'yes', bare: true }],
    ['Sounds good, go for it', { kind: 'yes', bare: true }],
    ['go ahead with that', { kind: 'yes', bare: true }],
    ['do it as proposed', { kind: 'yes', bare: true }],
    ['continue', { kind: 'yes', bare: true }],
    ['yes, and add tests for the parser', { kind: 'yes', bare: false }],
    ['2', { kind: 'choose', choice: 2, bare: true }],
    ['#3', { kind: 'choose', choice: 3, bare: true }],
    ['option two', { kind: 'choose', choice: 2, bare: true }],
    ['yes, the second one', { kind: 'choose', choice: 2, bare: true }],
    ['go with option 1', { kind: 'choose', choice: 1, bare: true }],
    ['both', { kind: 'all', bare: true }],
    ['yes, do all of them', { kind: 'all', bare: true }]
  ])('reads %j as an approval of its proposal', (text, approval) => {
    expect(contextualApprovalOf(text)).toEqual(approval)
  })

  it.each([
    'Run the unit tests and report failures.',
    'ok, run the unit tests',
    'continue with the refactor of parser.ts',
    'go fix the flaky test',
    'no',
    'What are you working on?',
    'Summarize progress.'
  ])('reads %j as an instruction, not an approval', (text) => {
    expect(contextualApprovalOf(text)).toBeNull()
  })
})
