import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listLocalWorkflowScope,
  materializeLocalWorkflowScope,
  LOCAL_WORKFLOW_EVIDENCE_LIMIT,
  LOCAL_WORKFLOW_FILE_LIMIT
} from './local-workflow-scope'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'local-workflow-scope-'))
  roots.push(path)
  return path
}

describe('host-owned local workflow scope', () => {
  it('lists only eligible text from a folder or git checkout and accepts empty prompt-only scope', async () => {
    const dir = root()
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, '.git', 'config'), 'private')
    writeFileSync(join(dir, '.env'), 'SECRET=private')
    writeFileSync(join(dir, 'node_modules', 'package.json'), '{}')
    writeFileSync(join(dir, 'src', 'answer.ts'), 'export const answer = 42\n')
    writeFileSync(join(dir, 'src', 'credentials.json'), '{}')
    writeFileSync(join(dir, 'src', 'server.pem'), 'private')
    writeFileSync(join(dir, 'image.png'), Buffer.from([0, 1, 2]))
    expect(await listLocalWorkflowScope(dir)).toEqual([
      { id: 'src/', label: 'src/' },
      { id: 'src/answer.ts', label: 'src/answer.ts' }
    ])
    expect(await materializeLocalWorkflowScope(dir, [])).toMatchObject({
      evidence: '',
      sources: [],
      refusals: [],
      truncated: false
    })
    const scope = await materializeLocalWorkflowScope(dir, ['src/answer.ts'])
    expect(scope.evidence).toBe('\n--- src/answer.ts ---\n   1| export const answer = 42\n')
    expect(scope.sources).toMatchObject([{ id: 'src/answer.ts', bytes: 25 }])
    expect(scope.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses traversal, forged paths, leaf symlinks and ancestor symlinks', async () => {
    const dir = root()
    const outside = root()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'safe.ts'), 'safe')
    writeFileSync(join(outside, 'outside.ts'), 'secret')
    symlinkSync(join(outside, 'outside.ts'), join(dir, 'link.ts'))
    symlinkSync(outside, join(dir, 'linked-dir'))
    await expect(materializeLocalWorkflowScope(dir, ['../outside.ts'])).rejects.toThrow(
      'Invalid workflow scope'
    )
    expect(
      (await materializeLocalWorkflowScope(dir, ['link.ts', 'linked-dir/outside.ts'])).refusals
    ).toHaveLength(2)
    const first = await materializeLocalWorkflowScope(dir, ['src/safe.ts'])
    expect(first.sources).toHaveLength(1)
    rmSync(join(dir, 'src'), { recursive: true })
    symlinkSync(outside, join(dir, 'src'))
    const second = await materializeLocalWorkflowScope(dir, ['src/safe.ts'])
    expect(second.evidence).toBe('')
    expect(second.refusals).toHaveLength(1)
  })

  it('rechecks changed files and explicitly refuses binary and over-limit content', async () => {
    const dir = root()
    writeFileSync(join(dir, 'changed.ts'), 'first')
    expect((await listLocalWorkflowScope(dir)).map((item) => item.id)).toContain('changed.ts')
    unlinkSync(join(dir, 'changed.ts'))
    writeFileSync(join(dir, 'changed.ts'), Buffer.from([0, 1, 2]))
    const changed = await materializeLocalWorkflowScope(dir, ['changed.ts'])
    expect(changed).toMatchObject({ evidence: '', truncated: true })
    expect(changed.refusals[0].reason).toMatch(/UTF-8 text/)
    writeFileSync(join(dir, 'huge.ts'), 'x'.repeat(LOCAL_WORKFLOW_FILE_LIMIT + 1))
    expect((await materializeLocalWorkflowScope(dir, ['huge.ts'])).refusals[0].reason).toMatch(
      /exceeds/
    )
  })

  it('caps total evidence with explicit refusals and no partial file content', async () => {
    const dir = root()
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `file${i}.ts`), 'x'.repeat(LOCAL_WORKFLOW_FILE_LIMIT))
    }
    const scope = await materializeLocalWorkflowScope(
      dir,
      Array.from({ length: 5 }, (_, i) => `file${i}.ts`)
    )
    expect(Buffer.byteLength(scope.evidence)).toBeLessThanOrEqual(LOCAL_WORKFLOW_EVIDENCE_LIMIT)
    expect(scope.sources).toHaveLength(3)
    expect(scope.refusals).toHaveLength(2)
    expect(scope.refusals[0].reason).toMatch(/Total evidence byte limit/)
    expect(scope.truncated).toBe(true)
  })

  it('lists ordinary source whose names mention auth, token or config, and keeps secrets out', async () => {
    const dir = root()
    mkdirSync(join(dir, 'config', 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'src'))
    for (const name of ['useAuth.ts', 'token-bucket.ts', 'oauth.ts', 'private-key.ts']) {
      writeFileSync(join(dir, 'src', name), 'export {}\n')
    }
    writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
    writeFileSync(join(dir, 'config', 'scripts', 'check.mjs'), 'export {}\n')
    for (const name of [
      '.env.local',
      '.npmrc',
      'auth.json',
      'secrets.yaml',
      'prod.env',
      'id.key'
    ]) {
      writeFileSync(join(dir, name), 'SECRET=1\n')
    }
    writeFileSync(join(dir, 'src', 'api-token.json'), '{}')
    // Files that carry credentials by convention, whatever their names say.
    for (const name of [
      'service-account.json',
      'wp-config.php',
      'database.yml',
      'appsettings.Production.json',
      'local.settings.json',
      'kubeconfig.yaml',
      'prod.tfvars.json',
      'credentials.xml'
    ]) {
      writeFileSync(join(dir, 'config', name), 'password: 1\n')
    }
    writeFileSync(join(dir, 'src', 'settings.py'), 'DEBUG = False\n')
    expect((await listLocalWorkflowScope(dir)).map((item) => item.id)).toEqual([
      'config/',
      'config/scripts/',
      'config/scripts/check.mjs',
      'src/',
      'src/oauth.ts',
      'src/private-key.ts',
      'src/settings.py',
      'src/token-bucket.ts',
      'src/useAuth.ts',
      'vite.config.ts'
    ])
  })

  it('lists folders breadth-first to depth 12 and attaches a folder as its file names', async () => {
    const dir = root()
    const shallow = join(dir, ...Array.from({ length: 11 }, (_, index) => `d${index}`))
    const deep = join(dir, ...Array.from({ length: 14 }, (_, index) => `d${index}`))
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(shallow, 'shallow.ts'), 'export {}\n')
    writeFileSync(join(deep, 'deep.ts'), 'export {}\n')
    const ids = (await listLocalWorkflowScope(dir)).map((item) => item.id)
    expect(ids).toContain(
      `${Array.from({ length: 11 }, (_, index) => `d${index}`).join('/')}/shallow.ts`
    )
    expect(ids.some((id) => id.endsWith('/deep.ts'))).toBe(false)
    const scope = await materializeLocalWorkflowScope(dir, ['d0/'])
    expect(scope.refusals).toEqual([])
    expect(scope.evidence).toContain('--- d0/ (folder) ---')
    expect(scope.evidence).toContain('/shallow.ts')
    expect(scope.sources).toMatchObject([{ id: 'd0/' }])
  })
})
