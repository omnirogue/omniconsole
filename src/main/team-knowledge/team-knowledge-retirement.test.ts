import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  retireTeamKnowledge,
  teamKnowledgeTargets,
  TEAM_KNOWLEDGE_MARKER_START as START,
  TEAM_KNOWLEDGE_MARKER_END as END
} from './team-knowledge-retirement'

let home: string
let userDataPath: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'omni-retirement-'))
  userDataPath = join(home, 'app-state')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const block = (eol = '\n') => `${START}${eol}team body${eol}${END}${eol}`
function write(path: string, text: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function run(mode: string, extra: NodeJS.ProcessEnv = {}) {
  return retireTeamKnowledge({
    home,
    userDataPath,
    env: { OMNI_TEAM_KNOWLEDGE_RETIREMENT: mode, ...extra }
  })
}

describe('connector-only team knowledge retirement', () => {
  it('is off by default and the kill switch prevents even dry-run writes', () => {
    expect(run('').status).toBe('disabled')
    expect(run('dry-run', { OMNI_TEAM_KNOWLEDGE_RETIREMENT_DISABLED: '1' }).status).toBe('disabled')
    expect(existsSync(userDataPath)).toBe(false)
  })

  it('requires an earlier matching dry-run and never includes instruction bodies in its report', () => {
    const path = teamKnowledgeTargets(home)[0]
    write(path, block())
    expect(run('apply').status).toBe('blocked')
    expect(readFileSync(path, 'utf8')).toBe(block())
    expect(run('dry-run').status).toBe('dry-run')
    expect(readFileSync(path, 'utf8')).toBe(block())
    expect(
      readFileSync(join(userDataPath, 'team-knowledge-retirement/dry-run.json'), 'utf8')
    ).not.toContain('team body')
  })

  it.each(['\n', '\r\n'])(
    'preserves all surrounding bytes, backs up each original and applies only once (%j)',
    (eol) => {
      const paths = teamKnowledgeTargets(home)
      const prefix = `Personal 🚀${eol}${eol}`
      const suffix = `${eol}  Keep spaces ${eol}`
      const original = prefix + block(eol) + suffix
      paths.forEach((path) => write(path, original))
      run('dry-run')
      const result = run('apply')
      expect(result.status).toBe('complete')
      expect(result.targets).toHaveLength(4)
      for (const target of result.targets) {
        expect(target.status).toBe('removed')
        expect(readFileSync(target.path, 'utf8')).toBe(prefix + suffix)
        expect(readFileSync(target.backup!, 'utf8')).toBe(original)
        expect(target.removedBytes).toBe(Buffer.byteLength(block(eol)))
      }
      expect(run('apply')).toEqual(result)
    }
  )

  it.each([
    `${START}\nmissing end`,
    `${END}\n${START}\n`,
    block() + block(),
    `inline ${block()}`,
    `${START}body\n${END}\n`
  ])('refuses all four writes when any marker pair is malformed: %j', (invalid) => {
    const paths = teamKnowledgeTargets(home)
    write(paths[0], block())
    write(paths[1], invalid)
    expect(run('dry-run').status).toBe('blocked')
    expect(run('apply').status).toBe('blocked')
    expect(readFileSync(paths[0], 'utf8')).toBe(block())
    expect(readFileSync(paths[1], 'utf8')).toBe(invalid)
  })

  it('refuses an edit made after dry-run and requires a fresh plan', () => {
    const path = teamKnowledgeTargets(home)[0]
    write(path, block())
    run('dry-run')
    write(path, `new personal text\n${block()}`)
    expect(run('apply').status).toBe('blocked')
    expect(readFileSync(path, 'utf8')).toContain('team body')
    run('dry-run')
    expect(run('apply').status).toBe('complete')
    expect(readFileSync(path, 'utf8')).toBe('new personal text\n')
  })

  it('does not overwrite a conflicting backup', () => {
    const path = teamKnowledgeTargets(home)[0]
    write(path, block())
    const plan = run('dry-run')
    const backup = join(
      userDataPath,
      'team-knowledge-retirement',
      `CLAUDE.md.${plan.targets[0].beforeSha}.bak`
    )
    write(backup, 'unrelated backup')
    expect(run('apply').status).toBe('blocked')
    expect(readFileSync(path, 'utf8')).toBe(block())
    expect(readFileSync(backup, 'utf8')).toBe('unrelated backup')
  })

  it('does not decode and rewrite invalid UTF-8', () => {
    const path = teamKnowledgeTargets(home)[0]
    const bytes = Buffer.concat([Buffer.from(block()), Buffer.from([0xff])])
    write(path, bytes)
    expect(run('dry-run').status).toBe('blocked')
    expect(readFileSync(path)).toEqual(bytes)
  })

  it('refuses symlinked global files without touching their targets', () => {
    if (process.platform === 'win32') {
      return
    }
    const path = teamKnowledgeTargets(home)[0]
    const actual = join(home, 'personal.md')
    write(actual, block())
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(actual, path)
    expect(run('dry-run').status).toBe('blocked')
    expect(readFileSync(actual, 'utf8')).toBe(block())
  })
})
