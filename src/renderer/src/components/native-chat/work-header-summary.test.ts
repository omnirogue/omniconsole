import { describe, expect, it } from 'vitest'
import {
  nextActionChainFixture,
  nextActionChainlessFixture
} from '../next-action/next-action-fixture'
import { workHeaderSummary } from './work-header-summary'

const session = { paneKey: 'tab:pane' }

describe('workHeaderSummary', () => {
  it('says nothing about an outcome that was never set', () => {
    expect(
      workHeaderSummary({
        chain: null,
        session,
        agentState: 'running',
        paneAgentState: 'working'
      }).text
    ).toBe('working')
  })

  it('never calls a finished turn with background work "working"', () => {
    const waiting = (paneBackgroundTaskCount?: number) =>
      workHeaderSummary({
        chain: null,
        session,
        agentState: 'running',
        paneAgentState: 'working',
        paneWorkingMode: 'monitoring',
        paneBackgroundTaskCount
      })
    // One wording and casing with the sidebar row and the activity line.
    expect(waiting(2)).toEqual({ kind: 'background', text: 'Waiting on background work (2)' })
    expect(waiting().text).toBe('Waiting on background work')
  })

  it('leads with the current goal’s milestone when there is no outcome', () => {
    expect(
      workHeaderSummary({
        chain: nextActionChainlessFixture(),
        session,
        agentState: 'idle',
        paneAgentState: null,
        progress: 'Checks · #1007, #1008 failing'
      }).text
    ).toBe('Checks · #1007, #1008 failing · idle · waiting for you')
  })

  it('keeps a committed outcome first', () => {
    expect(
      workHeaderSummary({
        chain: nextActionChainFixture(),
        session,
        agentState: 'idle',
        paneAgentState: null,
        progress: 'Checks · #1007 failing'
      }).text.startsWith('Verify signed IDE receipt handoff')
    ).toBe(true)
  })
})
