import { constants, type Stats } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CliInstallStatus, CliPathFinding } from '../../shared/cli-install-types'
import { isPermissionError } from './cli-install-errors'
import { quoteShell, splitPathEntries, uniquePathEntries } from './cli-install-path-format'

type DirectoryStats = Pick<Stats, 'mode' | 'uid' | 'gid' | 'isDirectory'>
type DoctorOptions = {
  platform?: NodeJS.Platform
  access?: (path: string, mode: number) => Promise<void>
  stat?: (path: string) => Promise<DirectoryStats>
  now?: () => number
}

export class CliPathDoctor {
  private readonly platform: NodeJS.Platform
  private readonly accessDirectory: NonNullable<DoctorOptions['access']>
  private readonly statDirectory: NonNullable<DoctorOptions['stat']>
  private readonly now: () => number
  private cache: { path: string; expiresAt: number; findings: Promise<CliPathFinding[]> } | null =
    null

  constructor(options: DoctorOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.accessDirectory = options.access ?? access
    this.statDirectory = options.stat ?? stat
    this.now = options.now ?? Date.now
  }

  getFindings(pathEnv: string): Promise<CliPathFinding[]> {
    if (this.cache?.path === pathEnv && this.now() < this.cache.expiresAt) {
      return this.cache.findings
    }
    const findings = this.scan(pathEnv)
    const cached = { path: pathEnv, expiresAt: this.now() + 30_000, findings }
    this.cache = cached
    void findings.catch(() => {
      if (this.cache === cached) {
        this.cache = null
      }
    })
    return findings
  }

  private async scan(pathEnv: string): Promise<CliPathFinding[]> {
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      return []
    }
    const findings: CliPathFinding[] = []
    for (const path of uniquePathEntries(this.platform, splitPathEntries(this.platform, pathEnv))) {
      const finding = await this.inspectDirectory(path)
      if (finding) {
        findings.push(finding)
      }
    }
    return findings
  }

  async inspectDirectory(path: string): Promise<CliPathFinding | null> {
    try {
      // Why: mode bits alone cannot tell whether this user can search a folder (groups/ACLs).
      await this.accessDirectory(path, constants.X_OK)
      return null
    } catch (error) {
      if (!isPermissionError(error)) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          return null
        }
        throw error
      }
    }
    let stats: DirectoryStats
    try {
      stats = await this.statDirectory(path)
    } catch (error) {
      if (isPermissionError(error)) {
        const parent = await this.findBlockingParent(path)
        if (parent) {
          const fix =
            parent.stats.uid === 0
              ? `sudo chmod 755 ${quoteShell(parent.path)}`
              : `ls -ld ${quoteShell(parent.path)}`
          return this.describeDirectory(path, parent.stats, fix, parent.path)
        }
      }
      return this.describeDirectory(path, null, `ls -ld ${quoteShell(path)}`)
    }
    if (!stats.isDirectory()) {
      return null
    }
    return this.describeDirectory(path, stats, `sudo chmod 755 ${quoteShell(path)}`)
  }

  private async findBlockingParent(
    path: string
  ): Promise<{ path: string; stats: DirectoryStats } | null> {
    let blocked = path
    for (;;) {
      const parent = dirname(blocked)
      if (parent === blocked) {
        return null
      }
      try {
        // Why: the first searchable parent makes the actual blocked folder's metadata reachable.
        await this.accessDirectory(parent, constants.X_OK)
      } catch (error) {
        if (!isPermissionError(error)) {
          return null
        }
        blocked = parent
        continue
      }
      if (blocked === path) {
        return null
      }
      const stats = await this.readDirectoryStats(blocked)
      return stats?.isDirectory() ? { path: blocked, stats } : null
    }
  }

  private async readDirectoryStats(path: string): Promise<DirectoryStats | null> {
    try {
      return await this.statDirectory(path)
    } catch {
      // Why: a blocked ancestor can also hide metadata; do not invent mode or ownership.
      return null
    }
  }

  private describeDirectory(
    path: string,
    stats: DirectoryStats | null,
    fix: string,
    blockedBy: string | null = null
  ): CliPathFinding {
    return {
      path,
      blockedBy,
      mode: stats ? (stats.mode & 0o7777).toString(8).padStart(4, '0') : null,
      ownerUid: stats?.uid ?? null,
      ownerGid: stats?.gid ?? null,
      fix
    }
  }

  private installError(commandPath: string, finding: CliPathFinding, reason: string): Error {
    const blockedAt = finding.blockedBy ? `blocked at ${finding.blockedBy}; ` : ''
    return new Error(
      `CLI registration failed: this app's user cannot reach ${commandPath}. ${reason} ` +
        `Folder: ${finding.path}; ${blockedAt}mode ${finding.mode ?? 'unknown'}; ` +
        `owner UID ${finding.ownerUid ?? 'unknown'}, GID ${finding.ownerGid ?? 'unknown'}. ` +
        `Fix: ${finding.fix}`
    )
  }

  async verifyInstall(
    commandPath: string,
    readStatus: () => Promise<CliInstallStatus>
  ): Promise<CliInstallStatus> {
    const folder = dirname(commandPath)
    let status: CliInstallStatus
    try {
      status = await readStatus()
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error
      }
      const blocked = await this.inspectDirectory(folder)
      const finding =
        blocked ??
        this.describeDirectory(
          folder,
          await this.readDirectoryStats(folder),
          `ls -l ${quoteShell(commandPath)}`
        )
      throw this.installError(
        commandPath,
        finding,
        blocked
          ? 'Its folder cannot be searched.'
          : 'The command entry is unreadable; check its permissions.'
      )
    }
    const blocked = await this.inspectDirectory(folder)
    if (blocked) {
      throw this.installError(
        commandPath,
        blocked,
        status.detail ?? 'Its folder cannot be searched.'
      )
    }
    if (status.state === 'conflict') {
      throw new Error(
        `CLI registration failed at ${commandPath}: ${status.detail ?? 'the command conflicts with another installation.'}`
      )
    }
    return status
  }
}
