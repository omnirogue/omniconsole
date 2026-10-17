import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from './tracer'
import {
  _resetLaunchStageTracesForTests,
  _trackedLaunchStageTraceCountForTests,
  beginLaunchStageTrace,
  completeLaunchStage,
  completeLaunchStageForPane,
  endLaunchStageTrace,
  hashLaunchWorktreeId
} from './launch-stage-trace'
import {
  _resetLatencyTelemetryEnabledReaderForTests,
  setLatencyTelemetryEnabledReader
} from './latency-probe-switch'
import type { LaunchTrigger } from '../../shared/launch-trigger'

type CapturedSink = TracerSink & { readonly records: Record<string, unknown>[] }

function makeCapturingSink(): CapturedSink {
  const records: Record<string, unknown>[] = []
  return {
    records,
    push(record) {
      records.push(record as Record<string, unknown>)
    },
    flush() {
      /* no-op */
    },
    close() {
      /* no-op */
    }
  }
}

function spanNames(sink: CapturedSink): string[] {
  return sink.records.map((record) => String(record.name))
}

function attributesFor(sink: CapturedSink, name: string): Record<string, unknown> {
  const record = sink.records.find((entry) => entry.name === name)
  return (record?.attributes ?? {}) as Record<string, unknown>
}

let sink: CapturedSink

beforeEach(() => {
  sink = makeCapturingSink()
  setActiveSink(sink)
  _resetLaunchStageTracesForTests()
})

afterEach(() => {
  _resetLaunchStageTracesForTests()
  _resetTracerForTests()
  _resetLatencyTelemetryEnabledReaderForTests()
})

describe('launch stage spans', () => {
  it('emits the four stages in order with elapsed values', () => {
    beginLaunchStageTrace({ launchId: 'session-1', paneKey: 'tab-1:pane-1', agent: 'codex' })
    completeLaunchStage('session-1', 'process_spawn', { outcome: 'spawned' })
    completeLaunchStage('session-1', 'shell_ready', {
      outcome: 'timeout_expired',
      reportedElapsedMs: 3_000
    })
    completeLaunchStage('session-1', 'startup_command', {
      outcome: 'flushed_after_timeout',
      queuedWrites: 1
    })
    completeLaunchStageForPane('tab-1:pane-1', 'agent_hook_status', { outcome: 'working' })

    expect(spanNames(sink)).toEqual([
      'launch.process_spawn',
      'launch.shell_ready',
      'launch.startup_command',
      'launch.agent_hook_status'
    ])
    for (const name of spanNames(sink)) {
      const attributes = attributesFor(sink, name)
      expect(attributes.kind).toBe('launch')
      expect(attributes['launch.id']).toBe('session-1')
      expect(attributes['launch.pane']).toBe('tab-1:pane-1')
      expect(attributes['launch.agent']).toBe('codex')
      expect(typeof attributes['launch.elapsed_ms']).toBe('number')
      expect(typeof attributes['launch.stage_ms']).toBe('number')
    }
    expect(attributesFor(sink, 'launch.shell_ready')['launch.outcome']).toBe('timeout_expired')
    expect(attributesFor(sink, 'launch.shell_ready')['launch.reported_elapsed_ms']).toBe(3_000)
    expect(attributesFor(sink, 'launch.startup_command')['launch.queued_writes']).toBe(1)
    // The trace is complete: the last stage releases its entry.
    expect(_trackedLaunchStageTraceCountForTests()).toBe(0)
  })

  // Why no prompt/credential/env content: a span attribute here is either a
  // number or a short token. Anything else is replaced, not truncated.
  it('never lets prompt, credential or environment text into a span', () => {
    const secret = 'sk-live-01 prompt: refactor the billing module'
    beginLaunchStageTrace({ launchId: 'session-2', paneKey: secret, agent: secret })
    completeLaunchStage('session-2', 'process_spawn', { outcome: secret })
    completeLaunchStage('session-2', 'shell_ready', { outcome: 'ready_marker' })

    const serialized = JSON.stringify(sink.records)
    expect(serialized).not.toContain('sk-live-01')
    expect(serialized).not.toContain('billing')
    expect(attributesFor(sink, 'launch.process_spawn')['launch.outcome']).toBe('invalid')
    expect(attributesFor(sink, 'launch.process_spawn')['launch.agent']).toBe('invalid')
  })

  it('attributes a stage boundary to the reported stage when an earlier stage never reported', () => {
    beginLaunchStageTrace({ launchId: 'session-3', agent: 'claude' })
    // No shell-ready report (an unsupported shell never gates delivery).
    completeLaunchStage('session-3', 'process_spawn', { outcome: 'spawned' })
    completeLaunchStage('session-3', 'startup_command', { outcome: 'delivered' })

    expect(spanNames(sink)).toEqual(['launch.process_spawn', 'launch.startup_command'])
  })

  it('ignores a stage that already passed and an unknown launch', () => {
    beginLaunchStageTrace({ launchId: 'session-4' })
    completeLaunchStage('session-4', 'shell_ready', { outcome: 'ready_marker' })
    completeLaunchStage('session-4', 'process_spawn', { outcome: 'spawned' })
    completeLaunchStage('session-nope', 'shell_ready', { outcome: 'ready_marker' })

    expect(spanNames(sink)).toEqual(['launch.shell_ready'])
  })

  it('discards the open stage when a launch ends early', () => {
    beginLaunchStageTrace({ launchId: 'session-5', agent: 'codex' })
    endLaunchStageTrace('session-5')

    expect(sink.records).toEqual([])
    expect(_trackedLaunchStageTraceCountForTests()).toBe(0)
  })

  it('bounds the number of tracked launches', () => {
    for (let index = 0; index < 200; index++) {
      beginLaunchStageTrace({ launchId: `session-${index}`, agent: 'codex' })
    }

    expect(_trackedLaunchStageTraceCountForTests()).toBeLessThanOrEqual(64)
  })

  it('is a no-op with no tracer sink installed', () => {
    setActiveSink(null)
    beginLaunchStageTrace({ launchId: 'session-6', agent: 'codex' })
    completeLaunchStage('session-6', 'process_spawn', { outcome: 'spawned' })

    expect(sink.records).toEqual([])
  })
})

describe('launch cause attributes (latency telemetry)', () => {
  const worktreeId = 'repo-1::/Users/maintainer/Work/secret-client/worktrees/billing'

  it('records trigger, visibility and a hashed worktree on the process_spawn span only', () => {
    beginLaunchStageTrace({
      launchId: 'session-t1',
      paneKey: 'tab-1:pane-1',
      agent: 'claude',
      trigger: 'person-reveal',
      visible: true,
      worktreeId
    })
    completeLaunchStage('session-t1', 'process_spawn', { outcome: 'spawned' })
    completeLaunchStage('session-t1', 'shell_ready', { outcome: 'ready_marker' })

    const spawn = attributesFor(sink, 'launch.process_spawn')
    expect(spawn['launch.trigger']).toBe('person-reveal')
    expect(spawn['launch.visible']).toBe(true)
    expect(spawn['launch.worktree']).toBe(hashLaunchWorktreeId(worktreeId))
    expect(spawn['launch.worktree']).toMatch(/^[0-9a-f]{12}$/)
    const shellReady = attributesFor(sink, 'launch.shell_ready')
    expect(shellReady['launch.trigger']).toBeUndefined()
    expect(shellReady['launch.worktree']).toBeUndefined()
  })

  it('never writes the worktree id or its path', () => {
    beginLaunchStageTrace({ launchId: 'session-t2', agent: 'codex', trigger: 'cli', worktreeId })
    completeLaunchStage('session-t2', 'process_spawn', { outcome: 'spawned' })

    const serialized = JSON.stringify(sink.records)
    expect(serialized).not.toContain('secret-client')
    expect(serialized).not.toContain('/Users/maintainer')
    expect(serialized).not.toContain('repo-1::')
  })

  it('defaults the trigger to unknown and omits visibility the caller does not know', () => {
    beginLaunchStageTrace({ launchId: 'session-t3', agent: 'codex' })
    completeLaunchStage('session-t3', 'process_spawn', { outcome: 'spawned' })

    const spawn = attributesFor(sink, 'launch.process_spawn')
    expect(spawn['launch.trigger']).toBe('unknown')
    expect('launch.visible' in spawn).toBe(false)
    expect('launch.worktree' in spawn).toBe(false)
  })

  it('writes a value outside the fixed token set as unknown', () => {
    beginLaunchStageTrace({
      launchId: 'session-t4',
      agent: 'codex',
      trigger: 'prompt: refactor billing' as LaunchTrigger,
      visible: 'yes' as unknown as boolean
    })
    completeLaunchStage('session-t4', 'process_spawn', { outcome: 'spawned' })

    const spawn = attributesFor(sink, 'launch.process_spawn')
    expect(spawn['launch.trigger']).toBe('unknown')
    expect('launch.visible' in spawn).toBe(false)
    expect(JSON.stringify(sink.records)).not.toContain('billing')
  })

  it('writes none of the cause attributes when the kill switch is off', () => {
    setLatencyTelemetryEnabledReader(() => false)
    beginLaunchStageTrace({
      launchId: 'session-t5',
      agent: 'claude',
      trigger: 'background-mount',
      visible: false,
      worktreeId
    })
    completeLaunchStage('session-t5', 'process_spawn', { outcome: 'spawned' })

    const spawn = attributesFor(sink, 'launch.process_spawn')
    expect(spawn['launch.id']).toBe('session-t5')
    expect('launch.trigger' in spawn).toBe(false)
    expect('launch.visible' in spawn).toBe(false)
    expect('launch.worktree' in spawn).toBe(false)
  })
})
