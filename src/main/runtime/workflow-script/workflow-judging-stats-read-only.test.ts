import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The stats are a report of the judging record and nothing more. These tests hold two lines:
 * no stats module can write a file, and nothing but the CLI, the RPC method and a view may read
 * the aggregator, so no seat, rubric or threshold can ever be tuned against the judges' wins.
 */

const SRC = resolve(__dirname, '../../..')
const STATS_MODULES = [
  'main/runtime/workflow-script/workflow-judging-stats.ts',
  'main/runtime/workflow-script/workflow-judging-stats-read.ts',
  'shared/workflow-judging-stats.ts',
  'cli/workflow-stats-format.ts',
  'cli/handlers/workflow-stats.ts'
]
const WRITE_APIS = ['writeFile', 'appendFile', 'rename', 'rm', 'mkdir', 'unlink', 'truncate']
const READERS_ALLOWED = ['cli/', 'main/runtime/rpc/', 'renderer/']

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) {
      continue
    }
    if (statSync(path).isDirectory()) {
      sources(path, into)
    } else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      into.push(path)
    }
  }
  return into
}

const posix = (path: string) => relative(SRC, path).split(sep).join('/')

describe('the judging stats are read-only', () => {
  it('imports no file-write API in any stats module', () => {
    for (const module of STATS_MODULES) {
      const source = readFileSync(join(SRC, module), 'utf8')
      for (const api of WRITE_APIS) {
        expect(source, `${module} names ${api}`).not.toMatch(new RegExp(`\\b${api}(Sync)?\\b`))
      }
      expect(source).not.toMatch(/node:child_process|node:fs\/promises/)
    }
  })

  it('is read by the CLI, the RPC method and views only', () => {
    const readers = sources(SRC)
      .filter((path) => /workflow-judging-stats(-read)?'/.test(readFileSync(path, 'utf8')))
      .map(posix)
      .filter((path) => !STATS_MODULES.includes(path))
    expect(readers.length).toBeGreaterThan(0)
    const outside = readers.filter(
      (path) => !READERS_ALLOWED.some((allowed) => path.startsWith(allowed))
    )
    expect(outside, 'a module outside the CLI, RPC and views reads the stats').toEqual([])
  })
})
