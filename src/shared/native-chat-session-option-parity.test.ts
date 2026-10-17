import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import {
  acceptReportedSessionOption,
  applyNativeChatReportedSessionOptions,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import type { SessionOptionDescriptor } from './native-chat-session-options'

/** A live session launched with `--model opus --effort xhigh`. */
function launchedRecord(effort = 'xhigh'): NativeChatSessionOptionRecord {
  const record = createNativeChatSessionOptionRecord('claude')
  record.model = { value: 'opus', source: 'applied' }
  record.valuesByModel.opus = { effort: { value: effort, source: 'applied' } }
  return record
}

function snapshot(
  record: NativeChatSessionOptionRecord,
  liveTransport?: 'catalog' | 'agent-session'
): SessionOptionDescriptor[] {
  return buildNativeChatSessionOptionSnapshot({
    catalog: CLAUDE_SESSION_OPTION_CATALOG,
    models: CLAUDE_SESSION_OPTION_CATALOG.models,
    record,
    mode: 'live',
    modelLabel: 'Model',
    ...(liveTransport ? { liveTransport } : {})
  })
}

function row(
  record: NativeChatSessionOptionRecord,
  id: string,
  liveTransport?: 'catalog' | 'agent-session'
): SessionOptionDescriptor {
  const descriptor = snapshot(record, liveTransport).find((entry) => entry.id === id)
  if (!descriptor) {
    throw new Error(`no ${id} descriptor`)
  }
  return descriptor
}

describe('requested vs applied session options', () => {
  it('keeps the requested effort beside the one the first provider frame reported', () => {
    const record = launchedRecord()
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' })
    expect(record.valuesByModel.opus?.effort).toEqual({
      value: 'high',
      source: 'reported',
      requested: 'xhigh'
    })
    const effort = row(record, 'effort')
    expect(effort.kind.type === 'select' && effort.kind.currentValue).toBe('high')
    expect(effort.parity).toMatchObject({
      state: 'mismatch',
      reason: 'effort-differs',
      requested: { effort: 'xhigh' },
      applied: { effort: 'high' }
    })
  })

  it('does not read the ladder level under a requested ultracode as a divergence', () => {
    // Claude Code prints `xhigh` in its frame while running ultracode; that report
    // cannot see the flag, so it is no observation of the request either way.
    const record = launchedRecord('ultracode')
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'xhigh' })
    expect(row(record, 'effort').parity).toBeUndefined()

    // A different ladder level is still a real divergence.
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' })
    expect(row(record, 'effort').parity).toMatchObject({
      state: 'mismatch',
      reason: 'effort-differs',
      requested: { effort: 'ultracode' },
      applied: { effort: 'high' }
    })
  })

  it('keeps a structured readback of xhigh under a requested ultracode as a divergence', () => {
    // A structured session's readback reports `ultracode` when the flag is on
    // (readClaudeSettingsEffort), so its plain `xhigh` is an affirmative "not adopted".
    const record = launchedRecord('ultracode')
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'xhigh' })
    expect(row(record, 'effort', 'agent-session').parity).toMatchObject({
      state: 'mismatch',
      reason: 'effort-differs',
      requested: { effort: 'ultracode' },
      applied: { effort: 'xhigh' }
    })
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'ultracode' })
    expect(row(record, 'effort', 'agent-session').parity).toBeUndefined()
  })

  it('shows a single value when the report agrees with the request', () => {
    const record = launchedRecord()
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'xhigh' })
    expect(record.valuesByModel.opus?.effort?.requested).toBeUndefined()
    expect(row(record, 'effort').parity).toBeUndefined()
    expect(row(record, 'model').parity).toBeUndefined()
  })

  it('surfaces the model the session actually reported, without dropping the request', () => {
    const record = launchedRecord()
    applyNativeChatReportedSessionOptions(record, { model: 'sonnet', effort: 'high' })
    expect(row(record, 'model').parity).toMatchObject({
      state: 'mismatch',
      reason: 'model-differs',
      requested: { model: 'opus' },
      applied: { model: 'sonnet' }
    })
    // The effort request survives the model swap instead of being silently adopted.
    expect(row(record, 'effort').parity).toMatchObject({ requested: { effort: 'xhigh' } })
  })

  it('refuses an effort the model does not advertise instead of reading it as applied', () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.model = { value: 'opus', source: 'applied' }
    record.valuesByModel.opus = { effort: { value: 'ultra', source: 'applied' } }
    expect(row(record, 'effort').parity).toMatchObject({
      state: 'unsupported',
      reason: 'effort-unsupported',
      requested: { effort: 'ultra' }
    })
  })

  it('clears the request when the person picks again', () => {
    const record = launchedRecord()
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' })
    setTrackedSessionOption(record, 'effort', 'xhigh', 'dispatched', 'opus')
    expect(record.valuesByModel.opus?.effort?.requested).toBeUndefined()
    expect(row(record, 'effort').parity).toBeUndefined()
  })

  it('settles a divergence only through an explicit accept', () => {
    const record = launchedRecord()
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' })
    expect(acceptReportedSessionOption(record, 'opus', 'effort')).toBe(true)
    expect(record.valuesByModel.opus?.effort).toEqual({ value: 'high', source: 'reported' })
    expect(row(record, 'effort').parity).toBeUndefined()
    expect(acceptReportedSessionOption(record, 'opus', 'effort')).toBe(false)
  })

  it('holds a surfaced divergence across later frames that keep reporting it', () => {
    const record = launchedRecord()
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' })
    applyNativeChatReportedSessionOptions(record, { model: 'opus', effort: 'high' })
    expect(record.valuesByModel.opus?.effort?.requested).toBe('xhigh')
  })
})
