#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const output =
  outputIndex === -1
    ? path.join(
        root,
        'native',
        'pty-process-observer-macos',
        '.build',
        'release',
        'omni-pty-process-observer'
      )
    : args[outputIndex + 1]
if (!output) {
  throw new Error('--output requires a path')
}
const work = mkdtempSync(path.join(tmpdir(), 'omni-pty-process-observer-'))
try {
  const architectures = args.includes('--single-arch')
    ? [process.arch === 'arm64' ? 'arm64' : 'x86_64']
    : ['arm64', 'x86_64']
  const binaries = architectures.map((architecture) => {
    const binary = path.join(work, architecture)
    execFileSync(
      '/usr/bin/clang',
      [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-arch',
        architecture,
        '-mmacosx-version-min=11.0',
        path.join(root, 'native', 'pty-process-observer-macos', 'main.c'),
        '-o',
        binary
      ],
      { stdio: 'inherit' }
    )
    return binary
  })
  mkdirSync(path.dirname(output), { recursive: true })
  if (binaries.length === 1) {
    copyFileSync(binaries[0], output)
  } else {
    execFileSync('/usr/bin/lipo', ['-create', ...binaries, '-output', output])
  }
  chmodSync(output, 0o755)
} finally {
  rmSync(work, { recursive: true, force: true })
}
