import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import {
  _resetLaunchStageTracesForTests,
  hashLaunchWorktreeId
} from '../observability/launch-stage-trace'
import {
  beginDaemonLaunchStageTrace,
  completeDaemonSpawnLaunchStage,
  launchStageTraceArgsFor
} from './daemon-spawn-launch-stage-trace'

let records: Record<string, unknown>[] = []

beforeEach(() => {
  records = []
  const sink: TracerSink = {
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
  setActiveSink(sink)
  _resetLaunchStageTracesForTests()
})

afterEach(() => {
  _resetLaunchStageTracesForTests()
  _resetTracerForTests()
})

describe('daemon spawn launch-stage trace', () => {
  it('carries the launch trigger and visibility onto launch.process_spawn', () => {
    beginDaemonLaunchStageTrace('session-d1', {
      cols: 80,
      rows: 24,
      command: 'claude --resume abc',
      launchAgent: 'claude',
      paneKey: 'tab-1:pane-1',
      worktreeId: 'repo::/Users/maintainer/wt',
      launchTrigger: 'background-mount',
      launchVisible: false
    })
    completeDaemonSpawnLaunchStage('session-d1')

    const spawn = records.find((record) => record.name === 'launch.process_spawn')
    const attributes = (spawn?.attributes ?? {}) as Record<string, unknown>
    expect(attributes['launch.trigger']).toBe('background-mount')
    expect(attributes['launch.visible']).toBe(false)
    expect(attributes['launch.worktree']).toBe(hashLaunchWorktreeId('repo::/Users/maintainer/wt'))
  })

  it('records unknown for a spawn whose caller did not name a trigger', () => {
    beginDaemonLaunchStageTrace('session-d2', { cols: 80, rows: 24, command: 'codex' })
    completeDaemonSpawnLaunchStage('session-d2')

    const spawn = records.find((record) => record.name === 'launch.process_spawn')
    const attributes = (spawn?.attributes ?? {}) as Record<string, unknown>
    expect(attributes['launch.trigger']).toBe('unknown')
  })

  it('maps spawn options to trace args for both the daemon and the local provider', () => {
    expect(
      launchStageTraceArgsFor('pty-1', {
        cols: 80,
        rows: 24,
        paneKey: 'tab-2:pane-9',
        launchAgent: 'codex',
        launchTrigger: 'cli',
        launchVisible: false,
        worktreeId: 'wt-1'
      })
    ).toEqual({
      launchId: 'pty-1',
      paneKey: 'tab-2:pane-9',
      agent: 'codex',
      trigger: 'cli',
      visible: false,
      worktreeId: 'wt-1'
    })
  })

  // Why a source check: the daemon and SSH relays survive app restarts, so a field they
  // never expected must not reach them. Both requests are built field by field today;
  // this fails loudly if a future edit forwards the main-only launch telemetry.
  it('never forwards the main-only launch telemetry to a daemon or relay request', () => {
    for (const file of [
      join(__dirname, 'daemon-pty-spawn-request.ts'),
      join(__dirname, '..', 'providers', 'ssh-pty-spawn-request.ts')
    ]) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/launchTrigger|launchVisible/)
    }
  })
})
