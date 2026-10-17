import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookSpoolPump } from './agent-hook-spool-pump'

it('does not rewrite an incomplete producer append or wake itself continuously', async () => {
  const endpointDir = mkdtempSync(join(tmpdir(), 'spool-torn-'))
  mkdirSync(join(endpointDir, 'spool'))
  const path = join(endpointDir, 'spool', 'pane-torn.jsonl')
  writeFileSync(path, '{"paneKey":"unfinished')
  const before = statSync(path).mtimeMs
  const ingest = vi.fn()
  const pump = new AgentHookSpoolPump(
    { endpointDir, ingest, getPersistedLaunchTokenHash: () => undefined },
    () => {}
  )
  try {
    expect(pump.start()).toBe(true)
    for (let iteration = 0; iteration < 5; iteration++) {
      await pump.flush()
    }
    expect(statSync(path).mtimeMs).toBe(before)
    expect(ingest).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe('{"paneKey":"unfinished')
  } finally {
    pump.stop()
    rmSync(endpointDir, { recursive: true, force: true })
  }
})

it('serializes concurrent flushes and leaves undelivered records durable after stop', async () => {
  const endpointDir = mkdtempSync(join(tmpdir(), 'spool-pump-'))
  mkdirSync(join(endpointDir, 'spool'))
  const path = join(endpointDir, 'spool', 'pane-test.jsonl')
  const record = `${JSON.stringify({
    paneKey: 'pane',
    source: 'claude',
    receivedAt: Date.now(),
    payload: {},
    queueToken: 'queue'
  })}\n`
  writeFileSync(path, record)
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const ingest = vi.fn(async () => {
    await hold
  })
  const pump = new AgentHookSpoolPump(
    {
      endpointDir,
      liveQueueToken: 'queue',
      getPersistedLaunchTokenHash: () => undefined,
      ingest
    },
    () => {}
  )
  try {
    const first = pump.flush()
    const second = pump.flush()
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1))
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ isReplay: false }))
    release()
    await Promise.all([first, second])
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(readFileSync(path, 'utf8')).toBe('')
    pump.stop()
    writeFileSync(path, record)
    await pump.flush()
    expect(readFileSync(path, 'utf8')).toBe(record)
  } finally {
    release()
    pump.stop()
    rmSync(endpointDir, { recursive: true, force: true })
  }
})
