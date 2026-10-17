import { describe, expect, it } from 'vitest'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'

describe('Bun-hosted OMP process identity', () => {
  it.each([
    'bun /Users/maintainer/.nvm/versions/node/v22/bin/omp --resume native-session',
    '/usr/local/bin/bun /usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
    'bun run /usr/local/bin/omp --resume native-session',
    String.raw`"C:\Program Files\bun\bun.exe" "C:\Users\sal\AppData\Roaming\npm\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js" --resume native-session`
  ])('recognizes the foreground entrypoint: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
      agent: 'omp',
      processName: 'omp'
    })
  })

  it.each(['bun', 'bun.exe', '/usr/local/bin/bun'])(
    'inspects %s without assigning an agent',
    (name) => {
      expect(isAgentForegroundWrapperProcess(name)).toBe(true)
      expect(recognizeAgentProcess(name)).toBeNull()
      expect(recognizeAgentProcessFromCommandLine(name)).toBeNull()
    }
  )

  it.each([
    'bun /tmp/server.js /usr/local/bin/omp',
    'bun server.js /usr/local/bin/omp',
    'bun run dev /usr/local/bin/omp',
    'bun test /usr/local/bin/omp',
    'bun build /usr/local/bin/omp',
    'bun --cwd /usr/local/bin/omp server.js',
    'bun --preload /usr/local/bin/omp server.js',
    'bun -e "console.log(1)" /usr/local/bin/omp',
    'bun /tmp/node_modules/@other/pi-coding-agent/dist/cli.js',
    'bun /tmp/node_modules/@oh-my-pi/pi-coding-agent/dist/not-cli.js'
  ])('refuses a generic Bun command with agent-like arguments: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })
})
