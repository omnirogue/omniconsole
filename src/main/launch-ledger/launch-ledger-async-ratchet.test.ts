import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
describe('launch recording main-thread contract', () => {
  it('does not use the synchronous file sink on the spawn path', () => {
    const source = [
      'src/main/launch-ledger/launch-ledger.ts',
      'src/main/launch-ledger/spawn-launch-record.ts',
      'src/main/observability/async-local-file-sink.ts'
    ]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(source).not.toMatch(/\bcreateLocalFileSink\b|\breadFileSync\b|\bfsyncSync\b/)
  })
})
