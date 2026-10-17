import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { webPageText } from './web-page-text'
import { webPageTextOffThread } from './web-page-text-runner'

let bundleRoot = ''
let workerPath = ''

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'omni-web-page-text-worker-'))
  workerPath = join(bundleRoot, 'web-page-text-worker.cjs')
  await build({
    entryPoints: [join(__dirname, 'web-page-text-worker.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent'
  })
}, 30_000)

afterAll(async () => {
  if (bundleRoot) {
    await rm(bundleRoot, { recursive: true, force: true })
  }
})

// Counts main-thread timer ticks while a promise runs: a blocked main thread would count none.
async function ticksDuring<T>(work: Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0
  const interval = setInterval(() => {
    ticks += 1
  }, 10)
  try {
    return { value: await work, ticks }
  } finally {
    clearInterval(interval)
  }
}

const HOSTILE_PAGES: [string, Buffer][] = [
  ['two million bytes of sibling paragraphs', Buffer.from('<p>x</p>'.repeat(262_144))],
  ['two million bytes of nested divs', Buffer.from('<div>'.repeat(419_430))]
]

describe('webPageTextOffThread', () => {
  it('gives the same text as the inline step for a real page', async () => {
    const fixture = readFileSync(join(__dirname, '__fixtures__', 'hidden-instructions.html'))
    const result = await webPageTextOffThread(fixture, 'text/html', null, { workerPath })
    expect(result).toEqual(webPageText(fixture, 'text/html', null))
    expect(result?.text).not.toContain('CANARY')
  })

  it.each(HOSTILE_PAGES)(
    'gives up on %s at its time limit while the main thread keeps running',
    async (_, body) => {
      const started = performance.now()
      const { value, ticks } = await ticksDuring(
        webPageTextOffThread(body, 'text/html', 'utf-8', { workerPath, timeoutMs: 1_000 })
      )
      expect(value).toBeNull()
      expect(performance.now() - started).toBeLessThan(5_000)
      expect(ticks).toBeGreaterThan(20)
    }
  )

  it('rejects with the Stop reason and does not wait for the worker', async () => {
    const controller = new AbortController()
    const stopped = new Error('run stopped')
    const pending = webPageTextOffThread(HOSTILE_PAGES[0]![1], 'text/html', null, {
      workerPath,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(stopped), 100)
    await expect(pending).rejects.toBe(stopped)
    await expect(
      webPageTextOffThread(Buffer.from('x'), 'text/plain', null, {
        workerPath,
        signal: controller.signal
      })
    ).rejects.toBe(stopped)
  })

  it('resolves null when the worker is missing or answers with something else', async () => {
    const missing = join(bundleRoot, 'no-such-worker.cjs')
    expect(
      await webPageTextOffThread(Buffer.from('x'), 'text/plain', null, { workerPath: missing })
    ).toBeNull()
    const liar = join(bundleRoot, 'liar-worker.cjs')
    await writeFile(liar, "require('node:worker_threads').parentPort.postMessage({ text: 1 })\n")
    expect(
      await webPageTextOffThread(Buffer.from('x'), 'text/plain', null, { workerPath: liar })
    ).toBeNull()
  })
})
