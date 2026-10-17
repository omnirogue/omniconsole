import { gitExecFileAsync } from '../git/runner'
import { redactString } from '../observability/redactor'

/** Inspect every added line in the unpublished commit range, including secrets removed by later commits. */
export async function consoleJobCredentialsAbsent(
  cwd: string,
  startSha: string,
  head: string,
  sanitize: (value: string) => string,
  signal?: AbortSignal
): Promise<boolean> {
  if (![startSha, head].every((value) => /^[a-f0-9]{40,64}$/.test(value))) {
    return false
  }
  try {
    const { stdout } = await gitExecFileAsync(
      [
        'log',
        '--format=',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-p',
        `${startSha}..${head}`,
        '--'
      ],
      { cwd, signal, timeout: 30_000, maxBuffer: 8_388_608 }
    )
    const additions = stdout
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n')
    return sanitize(additions) === additions && redactString(additions) === additions
  } catch {
    return false
  }
}
