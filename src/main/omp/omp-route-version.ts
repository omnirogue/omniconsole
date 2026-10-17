import { runProcess } from '../../shared/child-process/run-process'
import {
  findFirstExecutable,
  getExecutableNames,
  splitPath
} from '../../shared/node-cli-command-resolution'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

export async function assertOmpRouteVersion(environment?: NodeJS.ProcessEnv): Promise<void> {
  const env = environment ?? (await resolveLoginShellEnvironment())
  const program = findFirstExecutable(
    process.platform,
    splitPath(env.PATH),
    getExecutableNames(process.platform, 'omp')
  )
  if (!program) {
    throw new Error('OMP is not installed on this execution host.')
  }
  const result = await runProcess({
    program,
    args: ['--version'],
    env,
    timeoutMs: 10_000,
    maxOutputBytes: 4096
  })
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(result.stdout)
  if (
    result.code !== 0 ||
    !match ||
    Number(match[1]) < 18 ||
    (Number(match[1]) === 18 && Number(match[2]) < 2)
  ) {
    throw new Error('Exact model routing requires OMP 18.2 or later on the execution host.')
  }
}
