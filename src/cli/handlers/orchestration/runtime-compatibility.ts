import { RuntimeClientError } from '../../runtime-client'

export function resolveCompatibilityCliCommand(): 'omni' | 'omni-ide' | 'omni-dev' {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured === 'omni' || configured === 'omni-ide' || configured === 'omni-dev') {
    return configured
  }
  return process.platform === 'linux' ? 'omni-ide' : 'omni'
}

export function resolvePackagedWindowsCompatibilityCommand(): 'omni' | 'omni-ide' | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command === 'omni' || command === 'omni-ide') {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged OmniConsole launcher did not provide a valid resume command. No question was created.'
  )
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.ORCA_DEV_CLI_INVOCATION === '1' ||
    (process.env.ORCA_USER_DATA_PATH?.includes('omni-dev') ?? false)
  )
}
