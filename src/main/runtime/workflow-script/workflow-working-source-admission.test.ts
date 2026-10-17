import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { admitWorkingAgentGitSource } from './workflow-working-source-admission'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'working-source-'))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(root, 'index.html'), '<h1>Base</h1>')
  git('add', 'index.html')
  git('commit', '-qm', 'base')
  return { root, base: git('rev-parse', 'HEAD') }
}

describe('working-agent source admission', () => {
  it('pins a clean Git HEAD and rejects dirty HTML source that child workers would miss', async () => {
    const f = fixture()
    expect(await admitWorkingAgentGitSource(f.root)).toMatchObject({ sourceBase: f.base })
    writeFileSync(join(f.root, 'index.html'), '<h1>Dirty parent</h1>')
    await expect(admitWorkingAgentGitSource(f.root)).rejects.toThrow(/uncommitted/)
    execFileSync('git', ['checkout', '--', 'index.html'], { cwd: f.root })
    writeFileSync(join(f.root, 'new.html'), '<h1>Untracked</h1>')
    await expect(admitWorkingAgentGitSource(f.root)).rejects.toThrow(/untracked/)
  })

  it('refuses ordinary folders and nested directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'working-folder-'))
    roots.push(root)
    await expect(admitWorkingAgentGitSource(root)).rejects.toThrow(/Git worktree/)
    const f = fixture()
    mkdirSync(join(f.root, 'subdirectory'))
    await expect(admitWorkingAgentGitSource(join(f.root, 'subdirectory'))).rejects.toThrow(/root/)
  })
})
