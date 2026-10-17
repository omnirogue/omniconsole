import { describe, expect, it } from 'vitest'
import { readFleetSourceGitState } from '../main/runtime/conversation-fleet-source-git'
import { validateGitExecArgs } from './git-exec-validator'

describe('SSH source snapshot Git contract', () => {
  it.each([false, true])(
    'accepts the source reader with includeUntracked=%s',
    async (includeUntracked) => {
      const head = 'a'.repeat(40)
      const requested: string[][] = []
      const state = await readFleetSourceGitState(async (args) => {
        validateGitExecArgs(args)
        requested.push(args)
        if (args[0] === 'rev-parse') {
          if (args[1] === '--show-prefix') {
            return ''
          }
          return args[1] === '--verify' ? head : 'feature'
        }
        if (args[0] === 'status') {
          return includeUntracked ? '?? report.md\0' : ''
        }
        if (args[0] === 'diff') {
          return ''
        }
        if (args[0] === 'ls-files') {
          return `100644 ${head} 0\tREADME.md\0`
        }
        if (args[0] === 'ls-tree') {
          return `100644 blob ${head}\tREADME.md\0`
        }
        if (args[0] === 'remote') {
          return 'git@example.invalid:team/repo.git'
        }
        throw new Error(`Unexpected source command: ${args[0]}`)
      }, includeUntracked)
      expect(state).toMatchObject({
        baseCommit: head,
        branch: 'feature',
        changes: includeUntracked ? ['report.md'] : [],
        deletions: [],
        submodules: []
      })
      expect(requested.some((args) => args[0] === 'status')).toBe(true)
      expect(requested.some((args) => args[0] === 'ls-tree')).toBe(true)
    }
  )

  it.each([
    ['status'],
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
      '--output=/tmp/output'
    ],
    ['ls-tree', '-r', '-z', 'other-branch'],
    ['ls-tree', '-r', '-z', 'HEAD', '../other-repo'],
    ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', '../outside'],
    ['diff', '--no-index', '/etc/passwd', '/tmp/output'],
    [
      '-c',
      'core.fsmonitor=arbitrary-command',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
      '--ignore-submodules=none'
    ]
  ])('keeps non-snapshot arguments restricted: %j', (...args) => {
    expect(() => validateGitExecArgs(args)).toThrow()
  })
})
