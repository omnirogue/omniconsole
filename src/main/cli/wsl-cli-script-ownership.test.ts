import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  buildSafeReplaceGuard,
  getWslLauncherMarker,
  getWslBridgeMarker,
  hasManagedWslMarker
} from './wsl-cli-scripts'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('WSL persisted ownership across product names', () => {
  it.each(['Orca', 'OmniConsole'])('recognizes %s launcher and bridge markers', (brand) => {
    expect(hasManagedWslMarker(`# ${brand} managed WSL CLI launcher`, getWslLauncherMarker())).toBe(
      true
    )
    expect(
      hasManagedWslMarker(`# ${brand} managed WSL CLI PowerShell bridge`, getWslBridgeMarker())
    ).toBe(true)
    expect(hasManagedWslMarker('# user launcher', getWslLauncherMarker())).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'guards real files without claiming unmanaged files or symlinks',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'omniconsole-wsl-ownership-'))
      directories.push(root)
      const file = join(root, "launcher's file")
      for (const [contents, expected] of [
        ['# Orca managed WSL CLI launcher', 0],
        ['# OmniConsole managed WSL CLI launcher', 0],
        ['# User-owned command', 23]
      ] as const) {
        writeFileSync(file, contents)
        const result = await runProcess({
          program: '/bin/sh',
          args: ['-c', buildSafeReplaceGuard(file, getWslLauncherMarker())]
        })
        expect(result.code).toBe(expected)
      }
      const link = join(root, 'linked-launcher')
      symlinkSync(file, link)
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', buildSafeReplaceGuard(link, getWslLauncherMarker())]
      })
      expect(result.code).toBe(23)
    }
  )
})
