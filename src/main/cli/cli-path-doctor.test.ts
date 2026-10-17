import { constants } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CliPathDoctor } from './cli-path-doctor'

function permissionError(code = 'EACCES'): Error {
  return Object.assign(new Error('Permission denied'), { code })
}

function fixture(code = 'EACCES') {
  const callerUid = 501
  const folders = new Map([
    ['/root-only/bin', { mode: 0o40700, uid: 0, gid: 0 }],
    ['/public/bin', { mode: 0o40755, uid: 0, gid: 0 }],
    ['/home/private/bin', { mode: 0o40700, uid: callerUid, gid: 20 }],
    ['/admin/bin', { mode: 0o40770, uid: 0, gid: 80 }]
  ])
  const access = vi.fn(async (path: string, mode: number) => {
    expect(mode).toBe(constants.X_OK)
    if (path === '/root-only/bin') {
      throw permissionError(code)
    }
    if (!folders.has(path)) {
      throw Object.assign(new Error('Missing'), { code: 'ENOENT' })
    }
  })
  const stat = vi.fn(async (path: string) => ({
    ...folders.get(path)!,
    isDirectory: () => true
  }))
  let now = 0
  const doctor = new CliPathDoctor({ platform: 'darwin', access, stat, now: () => now })
  const path = [...folders.keys(), '/missing/bin', '/root-only/bin'].join(':')
  return {
    doctor,
    access,
    stat,
    path,
    advance: (ms: number) => {
      now += ms
    }
  }
}

function parentFixture(ownerUid: number) {
  const path = '/usr/local/bin/tools'
  const access = vi.fn(async (folder: string, mode: number) => {
    expect(mode).toBe(constants.X_OK)
    if (folder !== '/usr') {
      throw permissionError()
    }
  })
  const stat = vi.fn(async (folder: string) => {
    if (folder !== '/usr/local') {
      throw permissionError()
    }
    return { mode: 0o40700, uid: ownerUid, gid: 20, isDirectory: () => true }
  })
  return {
    path,
    access,
    stat,
    doctor: new CliPathDoctor({ platform: 'darwin', access, stat })
  }
}

describe('CliPathDoctor', () => {
  it.each(['EACCES', 'EPERM'])(
    'reports only folders this user cannot search (%s)',
    async (code) => {
      const { doctor, path, stat } = fixture(code)
      await expect(doctor.getFindings(path)).resolves.toEqual([
        {
          path: '/root-only/bin',
          blockedBy: null,
          mode: '0700',
          ownerUid: 0,
          ownerGid: 0,
          fix: "sudo chmod 755 '/root-only/bin'"
        }
      ])
      expect(stat).toHaveBeenCalledOnce()
      expect(stat).toHaveBeenCalledWith('/root-only/bin')
    }
  )

  it('does not report 0755, own 0700, searchable root:admin 0770 or nonexistent entries', async () => {
    const { doctor } = fixture()
    await expect(
      doctor.getFindings('/public/bin:/home/private/bin:/admin/bin:/missing/bin')
    ).resolves.toEqual([])
  })

  it('coalesces concurrent requests and caches the same PATH for 30 seconds', async () => {
    const { doctor, path, access, advance } = fixture()
    const first = doctor.getFindings(path)
    expect(doctor.getFindings(path)).toBe(first)
    await first
    const calls = access.mock.calls.length
    advance(29_999)
    expect(doctor.getFindings(path)).toBe(first)
    expect(access).toHaveBeenCalledTimes(calls)
    advance(1)
    await doctor.getFindings(path)
    expect(access).toHaveBeenCalledTimes(calls * 2)
  })

  it('inspects a changed PATH without returning the prior findings', async () => {
    const { doctor, path } = fixture()
    await doctor.getFindings(path)
    await expect(doctor.getFindings('/public/bin')).resolves.toEqual([])
  })

  it('quotes apostrophes in the suggested command', async () => {
    const doctor = new CliPathDoctor({
      platform: 'linux',
      access: async () => {
        throw permissionError()
      },
      stat: async () => ({ mode: 0o40700, uid: 0, gid: 0, isDirectory: () => true })
    })
    const [finding] = await doctor.getFindings("/home/it's/bin")
    expect(finding.fix).toBe(`sudo chmod 755 '/home/it'"'"'s/bin'`)
  })

  it.each([
    { ownerUid: 0, fix: "sudo chmod 755 '/usr/local'" },
    { ownerUid: 501, fix: "ls -ld '/usr/local'" }
  ])('identifies the blocked parent owned by UID $ownerUid', async ({ ownerUid, fix }) => {
    const { doctor, path, access, stat } = parentFixture(ownerUid)
    await expect(doctor.getFindings(path)).resolves.toEqual([
      {
        path,
        blockedBy: '/usr/local',
        mode: '0700',
        ownerUid,
        ownerGid: 20,
        fix
      }
    ])
    expect(access.mock.calls).toEqual([
      [path, constants.X_OK],
      ['/usr/local/bin', constants.X_OK],
      ['/usr/local', constants.X_OK],
      ['/usr', constants.X_OK]
    ])
    expect(stat.mock.calls).toEqual([[path], ['/usr/local']])
  })

  it('uses inspection advice when no blocking parent can be found', async () => {
    const doctor = new CliPathDoctor({
      platform: 'linux',
      access: async () => {
        throw permissionError()
      },
      stat: async () => {
        throw permissionError()
      }
    })
    await expect(doctor.getFindings('/blocked/bin')).resolves.toEqual([
      {
        path: '/blocked/bin',
        blockedBy: null,
        mode: null,
        ownerUid: null,
        ownerGid: null,
        fix: "ls -ld '/blocked/bin'"
      }
    ])
  })

  it('does not blame a parent this user can search when metadata remains inaccessible', async () => {
    const access = vi.fn(async (path: string, mode: number) => {
      expect(mode).toBe(constants.X_OK)
      if (path === '/blocked/bin') {
        throw permissionError()
      }
    })
    const doctor = new CliPathDoctor({
      platform: 'linux',
      access,
      stat: async () => {
        throw permissionError()
      }
    })
    await expect(doctor.getFindings('/blocked/bin')).resolves.toEqual([
      {
        path: '/blocked/bin',
        blockedBy: null,
        mode: null,
        ownerUid: null,
        ownerGid: null,
        fix: "ls -ld '/blocked/bin'"
      }
    ])
    expect(access.mock.calls).toEqual([
      ['/blocked/bin', constants.X_OK],
      ['/blocked', constants.X_OK]
    ])
  })

  it('does not search parents for a metadata failure unrelated to permissions', async () => {
    const access = vi.fn(async () => {
      throw permissionError()
    })
    const doctor = new CliPathDoctor({
      platform: 'linux',
      access,
      stat: async () => {
        throw new Error('I/O failure')
      }
    })
    const [finding] = await doctor.getFindings('/blocked/bin')
    expect(finding).toEqual({
      path: '/blocked/bin',
      blockedBy: null,
      mode: null,
      ownerUid: null,
      ownerGid: null,
      fix: "ls -ld '/blocked/bin'"
    })
    expect(access).toHaveBeenCalledOnce()
  })

  it('names the actual blocked parent in a post-install permission error', async () => {
    const { doctor, path } = parentFixture(0)
    await expect(
      doctor.verifyInstall(`${path}/omni`, async () => {
        throw permissionError()
      })
    ).rejects.toThrow(
      `Folder: ${path}; blocked at /usr/local; mode 0700; owner UID 0, GID 20. Fix: sudo chmod 755 '/usr/local'`
    )
  })

  it('ignores non-directory PATH entries', async () => {
    const doctor = new CliPathDoctor({
      platform: 'linux',
      access: async () => {
        throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' })
      }
    })
    await expect(doctor.getFindings('/file/bin')).resolves.toEqual([])
  })

  it('does not report a non-executable file as a blocked PATH folder', async () => {
    const doctor = new CliPathDoctor({
      platform: 'linux',
      access: async () => {
        throw permissionError()
      },
      stat: async () => ({ mode: 0o100644, uid: 0, gid: 0, isDirectory: () => false })
    })
    await expect(doctor.getFindings('/file')).resolves.toEqual([])
  })

  it('does not cache a failed inspection as a healthy result', async () => {
    const access = vi
      .fn()
      .mockRejectedValueOnce(new Error('I/O failure'))
      .mockResolvedValue(undefined)
    const doctor = new CliPathDoctor({ platform: 'linux', access })
    await expect(doctor.getFindings('/bin')).rejects.toThrow('I/O failure')
    await expect(doctor.getFindings('/bin')).resolves.toEqual([])
    expect(access).toHaveBeenCalledTimes(2)
  })

  it('does not offer Unix permission fixes on Windows', async () => {
    const access = vi.fn()
    const doctor = new CliPathDoctor({ platform: 'win32', access })
    await expect(doctor.getFindings('C:\\bin;D:\\tools')).resolves.toEqual([])
    expect(access).not.toHaveBeenCalled()
  })
})
