import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

describe('the relay bundle, with package C’s relocation steps in it (B3)', () => {
  // Why the metafile: `electron` is external in the relay build, so a stray import would only fail
  // on the SSH host at load; the source graph shows it here.
  it('reaches the relocation steps and no module that imports Electron', async () => {
    const result = await build({
      entryPoints: [join(REPO_ROOT, 'src', 'relay', 'relay.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      write: false,
      metafile: true,
      external: ['node-pty', '@parcel/watcher', 'electron'],
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent'
    })
    const { inputs } = result.metafile
    expect(Object.keys(inputs)).toEqual(
      expect.arrayContaining([
        'src/relay/relay-owner-relocation.ts',
        'src/main/session-manage/session-transfer-host-actions.ts',
        'src/main/session-manage/session-transfer-relocate-source.ts',
        'src/main/session-manage/session-transfer-relocation-bundle.ts'
      ])
    )
    const importsElectron = Object.entries(inputs)
      .filter(([, input]) => input.imports.some((entry) => entry.path === 'electron'))
      .map(([file]) => file)
    expect(importsElectron).toEqual([])
  }, 60_000)
})
