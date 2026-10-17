import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPosixWorktreeMemoryLinkLines } from './worktree-memory-link-script'

const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omni-memlink-')))
  const main = join(root, 'repo')
  const wt = join(root, 'wt')
  const cfg = join(root, 'claude-cfg')
  mkdirSync(main)
  const git = (args: string[], cwd = main) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  git(['worktree', 'add', '-q', wt, '-b', 'feature'])
  const script = join(root, 'hook.sh')
  writeFileSync(
    script,
    ['#!/bin/sh', 'payload=$(cat)', ...buildPosixWorktreeMemoryLinkLines(), 'exit 0', ''].join('\n')
  )
  chmodSync(script, 0o755)
  return { main, wt, cfg, script }
}

function run(script: string, cwd: string, cfg: string, event = 'SessionStart', orca = true) {
  return spawnSync('/bin/sh', [script], {
    cwd,
    input: `{"hook_event_name":"${event}","cwd":"${cwd}"}\n`,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: cfg,
      ...(orca ? { ORCA_WORKTREE_ID: 'wt-1' } : {})
    },
    timeout: 10000,
    encoding: 'utf8'
  })
}

describe('posix worktree memory link', () => {
  it('links the worktree memory dir to the main checkout memory on SessionStart', () => {
    const { main, wt, cfg, script } = setup()
    const res = run(script, wt, cfg)
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    const dst = join(cfg, 'projects', slug(wt), 'memory')
    const src = join(cfg, 'projects', slug(main), 'memory')
    expect(lstatSync(dst).isSymbolicLink()).toBe(true)
    expect(readlinkSync(dst)).toBe(src)
    expect(existsSync(src)).toBe(true)
    // idempotent
    expect(run(script, wt, cfg).status).toBe(0)
    expect(readlinkSync(dst)).toBe(src)
  })

  it('is inert in the main checkout, outside Orca, on other events, and over a populated dir', () => {
    const { main, wt, cfg, script } = setup()
    run(script, main, cfg)
    expect(existsSync(join(cfg, 'projects', slug(main)))).toBe(false)
    run(script, wt, cfg, 'SessionStart', false)
    expect(existsSync(join(cfg, 'projects', slug(wt)))).toBe(false)
    run(script, wt, cfg, 'UserPromptSubmit')
    expect(existsSync(join(cfg, 'projects', slug(wt)))).toBe(false)
    const dst = join(cfg, 'projects', slug(wt), 'memory')
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'MEMORY.md'), '# local\n')
    run(script, wt, cfg)
    expect(lstatSync(dst).isSymbolicLink()).toBe(false)
  })
})
