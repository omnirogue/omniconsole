import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileWorkflowScriptJournal, MemoryWorkflowScriptJournal } from './workflow-script-journal'
import { WorkflowScriptSlots } from './workflow-script-slots'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FileWorkflowScriptJournal', () => {
  it('appends answers as JSONL and reads them back, ignoring a torn last line', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wfs-journal-'))
    dirs.push(dir)
    const file = path.join(dir, 'run', 'journal.jsonl')
    const journal = new FileWorkflowScriptJournal(file)
    expect(await journal.get('v1:a:1')).toBeUndefined()
    await journal.put('v1:a:1', { findings: [] })
    await journal.put('v1:b:1', 'text')
    expect(await readFile(file, 'utf8')).toBe(
      '{"key":"v1:a:1","value":{"findings":[]}}\n{"key":"v1:b:1","value":"text"}\n'
    )
    await writeFile(file, `${await readFile(file, 'utf8')}{"key":"v1:c:1","val`)
    const reopened = new FileWorkflowScriptJournal(file)
    expect(await reopened.get('v1:a:1')).toEqual({ value: { findings: [] } })
    expect(await reopened.get('v1:b:1')).toEqual({ value: 'text' })
    expect(await reopened.get('v1:c:1')).toBeUndefined()
  })
})

describe('MemoryWorkflowScriptJournal', () => {
  it('holds seeded answers', async () => {
    const journal = new MemoryWorkflowScriptJournal([['k', 1]])
    expect(await journal.get('k')).toEqual({ value: 1 })
    expect(journal.size).toBe(1)
  })
})

describe('WorkflowScriptSlots', () => {
  it('runs at most the limit at once, in arrival order, and frees a slot when work throws', async () => {
    const slots = new WorkflowScriptSlots(2)
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = slots.run(async () => {
      order.push('a')
      await gate
    })
    const b = slots.run(async () => {
      order.push('b')
      throw new Error('x')
    })
    const c = slots.run(async () => {
      order.push('c')
    })
    await Promise.resolve()
    expect(slots.running).toBeLessThanOrEqual(2)
    await b.catch(() => {})
    await c
    release()
    await a
    expect(order).toEqual(['a', 'b', 'c'])
    expect(slots.running).toBe(0)
    expect(slots.queued).toBe(0)
    expect(() => new WorkflowScriptSlots(0)).toThrow(RangeError)
  })
})
