import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home.dir }
})

import { sessionPrepPathExists } from './session-prep-path'

describe('sessionPrepPathExists', () => {
  it('accepts a file under cwd and refuses parent paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-prep-path-'))
    home.dir = await mkdtemp(join(tmpdir(), 'session-prep-home-'))
    await writeFile(join(cwd, 'readme.md'), 'ok', 'utf8')
    expect(await sessionPrepPathExists(cwd, 'readme.md')).toBe(true)
    expect(await sessionPrepPathExists(cwd, 'missing.md')).toBe(false)
    expect(await sessionPrepPathExists(cwd, '../readme.md')).toBe(false)
  })

  it('accepts an existing absolute path only inside the home folder', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-prep-path-'))
    home.dir = await mkdtemp(join(tmpdir(), 'session-prep-home-'))
    await mkdir(join(home.dir, 'Desktop'))
    await writeFile(join(home.dir, 'Desktop', 'brief.pdf'), 'pdf', 'utf8')
    await writeFile(join(cwd, 'outside.md'), 'ok', 'utf8')
    expect(await sessionPrepPathExists(cwd, join(home.dir, 'Desktop', 'brief.pdf'))).toBe(true)
    expect(await sessionPrepPathExists(cwd, join(home.dir, 'Desktop', 'missing.pdf'))).toBe(false)
    expect(await sessionPrepPathExists(cwd, join(cwd, 'outside.md'))).toBe(false)
    expect(await sessionPrepPathExists(cwd, join(home.dir, '..', 'etc'))).toBe(false)
  })
})
