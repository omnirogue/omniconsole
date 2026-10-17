import { gitExecFileAsync } from './runner'
import {
  DEFAULT_BASE_REF_PROBE_TIMEOUT_MS,
  gitExecOptions,
  type LocalGitExecOptions
} from './repo-default-base-ref'

export type DriftSubjectsRead = { status: 'known'; subjects: string[] } | { status: 'unknown' }

export async function readRecentDriftSubjects(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  limit: number,
  options: LocalGitExecOptions = {}
): Promise<DriftSubjectsRead> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['log', '--format=%s', '-n', String(limit), `${localRef}..${remoteRef}`],
      {
        ...gitExecOptions(repoPath, options),
        timeout: DEFAULT_BASE_REF_PROBE_TIMEOUT_MS
      }
    )
    return {
      status: 'known',
      subjects: stdout.split('\n').filter((subject) => subject.trim().length > 0)
    }
  } catch {
    return { status: 'unknown' }
  }
}
