import { mkdtemp, mkdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

import { ensureCompanyFolder } from './company-workspaces'

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'company-folders-'))
  await mkdir(join(home, 'Work'), { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureCompanyFolder', () => {
  it('creates a department folder inside the configured work root', async () => {
    const target = join(home, 'Work', 'ApexLabs', 'Customer Service')

    const result = await ensureCompanyFolder({
      path: target,
      settings: { companyWorkRoot: '~/Work' },
      home
    })

    expect(result).toEqual({ ok: true, created: true })
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  it('reports an existing folder as not created', async () => {
    const target = join(home, 'Work', 'OmniRogue')
    await mkdir(target, { recursive: true })

    expect(
      await ensureCompanyFolder({ path: target, settings: { companyWorkRoot: '~/Work' }, home })
    ).toEqual({ ok: true, created: false })
  })

  it('expands ~ against the caller home', async () => {
    const result = await ensureCompanyFolder({
      path: '~/Work/OmniRogue/Marketing',
      settings: { companyWorkRoot: '~/Work' },
      home
    })

    expect(result).toEqual({ ok: true, created: true })
    expect((await stat(join(home, 'Work', 'OmniRogue', 'Marketing'))).isDirectory()).toBe(true)
  })

  it('refuses a path outside the work root', async () => {
    const outside = join(home, 'Elsewhere', 'Secret')

    const result = await ensureCompanyFolder({
      path: outside,
      settings: { companyWorkRoot: '~/Work' },
      home
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('outside the company work root')
    await expect(stat(outside)).rejects.toThrow()
  })

  it('refuses a symlinked ancestor that leads out of the work root', async () => {
    await mkdir(join(home, 'Elsewhere'), { recursive: true })
    await symlink(join(home, 'Elsewhere'), join(home, 'Work', 'escape'))

    const result = await ensureCompanyFolder({
      path: join(home, 'Work', 'escape', 'Marketing'),
      settings: { companyWorkRoot: '~/Work' },
      home
    })

    expect(result.ok).toBe(false)
    await expect(stat(join(home, 'Elsewhere', 'Marketing'))).rejects.toThrow()
  })

  it('refuses a relative path without touching the disk', async () => {
    const result = await ensureCompanyFolder({
      path: 'Work/OmniRogue',
      settings: { companyWorkRoot: '~/Work' },
      home
    })

    expect(result).toEqual({
      ok: false,
      message: 'That is not an absolute folder path, so nothing was created.'
    })
  })

  it('refuses when a file already holds the path', async () => {
    const target = join(home, 'Work', 'OmniRogue')
    await writeFile(target, 'not a folder')

    const result = await ensureCompanyFolder({
      path: target,
      settings: { companyWorkRoot: '~/Work' },
      home
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('A file already uses that path')
  })
})
