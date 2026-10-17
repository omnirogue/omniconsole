import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { anonymousCandidatePacket, captureCandidateArtifacts } from './workflow-working-artifacts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-artifacts-'))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(root, 'index.html'), '<h1>Original</h1>\n')
  git('add', 'index.html')
  git('commit', '-qm', 'base')
  return { root, base: git('rev-parse', 'HEAD') }
}

describe('working candidate artifacts', () => {
  it('captures changed and untracked project files with stable digest and relative paths', async () => {
    const { root, base } = fixture()
    writeFileSync(join(root, 'index.html'), '<h1>Built page</h1>\n')
    writeFileSync(join(root, 'theme.css'), 'h1 { color: blue; }\n')
    const first = await captureCandidateArtifacts(root, base)
    const second = await captureCandidateArtifacts(root, base)
    expect(first).toEqual(second)
    expect(first.files.map((file) => file.relativePath)).toEqual(['index.html', 'theme.css'])
    expect(first.files[0].contentPreview).toContain('Built page')
    expect(first.diff).toContain('-<h1>Original</h1>')
    expect(first.diff).toContain('+<h1>Built page</h1>')
    expect(first.diff).not.toContain(root)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      anonymousCandidatePacket({ markdown: 'Built a page.' }, first, 'Response A')
    ).toMatchObject({
      label: 'Response A',
      artifacts: first
    })
  })

  it('omits private, oversized, binary and redirected files without reading outside the worktree', async () => {
    const { root, base } = fixture()
    const outside = join(tmpdir(), `workflow-artifacts-outside-${Date.now()}.txt`)
    writeFileSync(outside, 'DO NOT COPY')
    try {
      writeFileSync(join(root, '.env'), 'PRIVATE=1')
      writeFileSync(join(root, '.npmrc'), '//registry.example.test/:_authToken=supersecret')
      writeFileSync(
        join(root, 'config.txt'),
        'api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
      )
      writeFileSync(join(root, 'huge.txt'), 'x'.repeat(64 * 1024 + 1))
      writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
      symlinkSync(outside, join(root, 'linked.txt'))
      const result = await captureCandidateArtifacts(root, base)
      expect(result.files).toEqual([])
      expect(result.omissions.map((entry) => entry.relativePath)).toEqual([
        '.env',
        '.npmrc',
        'binary.bin',
        'config.txt',
        'huge.txt',
        'linked.txt'
      ])
      expect(JSON.stringify(result)).not.toContain('DO NOT COPY')
      expect(JSON.stringify(result)).not.toContain('PRIVATE=1')
      expect(JSON.stringify(result)).not.toContain('supersecret')
      expect(JSON.stringify(result)).not.toContain('sk-proj-')
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('omits a diff that removes a credential even when the new file is safe', async () => {
    const { root, base } = fixture()
    writeFileSync(join(root, 'index.html'), '<h1>Built page</h1>\n')
    // Test the reverse direction: old committed content must not leak via the diff.
    writeFileSync(
      join(root, 'settings.txt'),
      'api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n'
    )
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('add', 'settings.txt')
    git('commit', '-qm', 'credential fixture')
    const secretBase = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(root, 'settings.txt'), 'No credentials remain.\n')
    const result = await captureCandidateArtifacts(root, secretBase)
    expect(result.files.some((file) => file.relativePath === 'settings.txt')).toBe(true)
    expect(result.diff).not.toContain('sk-proj-')
    expect(result.omissions).toContainEqual({
      relativePath: 'settings.txt',
      reason: 'diff contains protected credential content'
    })
    expect(base).not.toBe(secretBase)
  })

  it('rejects anonymous packets with invalid digest or explicit provider and worktree identities', async () => {
    const { root, base } = fixture()
    const artifacts = await captureCandidateArtifacts(root, base)
    expect(() => anonymousCandidatePacket('I am Claude.', artifacts, 'Response A')).toThrow(
      'identifying metadata'
    )
    expect(() =>
      anonymousCandidatePacket('/Users/maintainer/project', artifacts, 'Response A')
    ).toThrow('identifying metadata')
    expect(() => anonymousCandidatePacket('Fine', artifacts, 'seat-1')).toThrow('invalid')
    expect(() =>
      anonymousCandidatePacket('Fine', { ...artifacts, diff: 'tampered' }, 'Response A')
    ).toThrow('invalid')
  })

  it('refuses a non-commit base and a path below rather than at the worktree root', async () => {
    const { root, base } = fixture()
    await expect(captureCandidateArtifacts(root, 'HEAD')).rejects.toThrow('pinned commit hash')
    await expect(captureCandidateArtifacts(join(root, '.git'), base)).rejects.toThrow(
      'worktree root'
    )
  })
})
