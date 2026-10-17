import { describe, expect, it } from 'vitest'
import { workflowContextLayout } from './workflow-context-layout'
import {
  workflowContextAddSources,
  workflowContextSourceValid,
  workflowGitHubRepoValid,
  workflowGitRefIsCommit,
  workflowGitRefValid
} from './workflow-context-sources'

describe('the context folder layout', () => {
  it('puts the workspace, each path and each repository in its own folder', () => {
    expect(
      workflowContextLayout(
        [
          { kind: 'path', path: '/Users/maintainer/Work/notes' },
          { kind: 'path', path: 'C:\\Users\\sal\\brief.md' },
          { kind: 'github', repo: 'omnirogue/omni-ide', ref: 'feat/x' },
          { kind: 'github', repo: 'acme/api' }
        ],
        true
      )
    ).toEqual([
      { kind: 'workspace', folder: 'workspace' },
      { kind: 'path', path: '/Users/maintainer/Work/notes', folder: 'notes' },
      { kind: 'path', path: 'C:\\Users\\sal\\brief.md', folder: 'brief.md' },
      {
        kind: 'github',
        repo: 'omnirogue/omni-ide',
        ref: 'feat/x',
        folder: 'github/ApexLabs__omni-ide@feat_x'
      },
      { kind: 'github', repo: 'acme/api', folder: 'github/acme__api@default' }
    ])
  })

  it('never lets two sources share a folder, whatever their case', () => {
    const folders = workflowContextLayout(
      [
        { kind: 'path', path: '/a/src' },
        { kind: 'path', path: '/b/SRC' },
        { kind: 'path', path: '/c/workspace' },
        { kind: 'path', path: '/d/github' },
        { kind: 'github', repo: 'acme/api', ref: 'a/b' },
        { kind: 'github', repo: 'acme/api', ref: 'a_b' }
      ],
      false
    ).map((entry) => entry.folder)
    expect(folders).toEqual([
      'src',
      'SRC-2',
      'workspace-2',
      'github-2',
      'github/acme__api@a_b',
      'github/acme__api@a_b-2'
    ])
  })

  it('makes hidden and unusual names plain', () => {
    expect(
      workflowContextLayout([{ kind: 'path', path: '/x/.hidden stuff:?' }], false)[0]!.folder
    ).toBe('hidden stuff__')
    expect(workflowContextLayout([{ kind: 'path', path: '/x/...' }], false)[0]!.folder).toBe('item')
  })
})

describe('which sources are valid', () => {
  it('accepts GitHub owner/name and refuses anything else', () => {
    expect(workflowGitHubRepoValid('omnirogue/omni-ide')).toBe(true)
    expect(workflowGitHubRepoValid('vercel/next.js')).toBe(true)
    for (const repo of ['acme', 'acme/api/x', '-acme/api', 'acme/..', 'acme/a b', '../etc']) {
      expect(workflowGitHubRepoValid(repo)).toBe(false)
    }
  })

  it('accepts branches, tags and commits that are safe as one git argument', () => {
    for (const ref of ['main', 'feat/login', 'v1.2.3', 'a'.repeat(40)]) {
      expect(workflowGitRefValid(ref)).toBe(true)
    }
    for (const ref of ['', '-c', '--upload-pack=x', 'a..b', 'a b', 'x~1', 'x^', 'a:b', 'x.lock']) {
      expect(workflowGitRefValid(ref)).toBe(false)
    }
    expect(workflowGitRefIsCommit('0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(workflowGitRefIsCommit('main')).toBe(false)
  })

  it('refuses a blank or padded path and adds each valid source once', () => {
    expect(workflowContextSourceValid({ kind: 'path', path: ' /a' })).toBe(false)
    expect(workflowContextSourceValid({ kind: 'path', path: '' })).toBe(false)
    expect(
      workflowContextAddSources(
        [{ kind: 'github', repo: 'acme/api' }],
        [
          { kind: 'github', repo: 'ACME/api' },
          { kind: 'github', repo: 'acme/api', ref: 'dev' },
          { kind: 'github', repo: 'nope' },
          { kind: 'path', path: '/a/b' }
        ]
      )
    ).toEqual([
      { kind: 'github', repo: 'acme/api' },
      { kind: 'github', repo: 'acme/api', ref: 'dev' },
      { kind: 'path', path: '/a/b' }
    ])
  })
})
