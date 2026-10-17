import { readFile } from 'node:fs/promises'
import { runProcess } from '../shared/child-process/run-process'

/** Returns null when this host cannot prove a process birth; callers keep the claim then. */
export async function readLaunchClaimProcessBirth(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const [stat, systemStat] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/stat', 'utf8')
      ])
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
      const ticks = Number(fields[19])
      const boot = Number(/^btime\s+(\d+)$/m.exec(systemStat)?.[1])
      return Number.isFinite(ticks) && Number.isFinite(boot)
        ? Math.round(boot * 1000 + (ticks / 100) * 1000)
        : null
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    try {
      const result = await runProcess({
        program: 'ps',
        args: ['-o', 'lstart=', '-p', String(pid)],
        timeoutMs: 5_000
      })
      const birth = Date.parse(result.stdout.trim())
      return !result.timedOut && result.code === 0 && Number.isFinite(birth) ? birth : null
    } catch {
      return null
    }
  }
  return null
}
