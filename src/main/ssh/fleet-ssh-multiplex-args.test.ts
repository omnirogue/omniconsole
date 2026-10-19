import { describe, expect, it } from 'vitest'
import {
  FLEET_SSH_CONTROL_PATH,
  FLEET_SSH_CONTROL_PERSIST_SECONDS,
  buildFleetSshMasterControlArgs,
  buildFleetSshMultiplexArgs,
  findFleetSshForwardingOptions,
  planFleetSshMultiplex
} from './fleet-ssh-multiplex-args'

function optionValues(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-o') {
      values.push(args[index + 1])
    }
  }
  return values
}

describe('fleet SSH multiplex constants', () => {
  it('uses a short %C socket under ~/.ssh so routes never share a master', () => {
    expect(FLEET_SSH_CONTROL_PATH).toBe('~/.ssh/cm-%C')
    expect(FLEET_SSH_CONTROL_PATH).toContain('%C')
    // Why: sun_path is ~104 bytes on macOS; the expanded %C hash is 40 hex chars.
    expect(FLEET_SSH_CONTROL_PATH.length).toBeLessThan(20)
  })

  it('keeps an idle master for ten minutes', () => {
    expect(FLEET_SSH_CONTROL_PERSIST_SECONDS).toBe(600)
  })
})

describe('buildFleetSshMultiplexArgs', () => {
  it('enables ControlMaster=auto with the fleet socket and persist for an ordinary probe', () => {
    const args = buildFleetSshMultiplexArgs({ platform: 'darwin' })

    expect(optionValues(args)).toEqual([
      'ControlMaster=auto',
      'ControlPath=~/.ssh/cm-%C',
      'ControlPersist=600',
      'ClearAllForwardings=yes'
    ])
    expect(args).not.toContain('-S')
  })

  it('pairs every option value with its own -o flag', () => {
    const args = buildFleetSshMultiplexArgs({ platform: 'linux' })

    expect(args).toHaveLength(8)
    for (let index = 0; index < args.length; index += 2) {
      expect(args[index]).toBe('-o')
      expect(args[index + 1]).toMatch(/^[A-Za-z]+=/)
    }
  })

  it('clears config-defined forwards on the probe that may become the shared master', () => {
    const args = buildFleetSshMultiplexArgs({ platform: 'linux', sshArgs: ['-o', 'BatchMode=yes'] })

    expect(optionValues(args)).toContain('ClearAllForwardings=yes')
  })

  it('treats a missing request as an ordinary probe on the current platform', () => {
    const expected = process.platform === 'win32' ? ['-S', 'none'] : undefined
    const args = buildFleetSshMultiplexArgs()

    if (expected) {
      expect(args).toEqual(expected)
    } else {
      expect(optionValues(args)).toContain('ControlMaster=auto')
    }
  })

  it.each([
    ['-L', '8080:127.0.0.1:80'],
    ['-R', '9000:localhost:9000'],
    ['-D', '1080']
  ])('opts out of the shared master when %s forwarding is requested', (flag, value) => {
    const args = buildFleetSshMultiplexArgs({ platform: 'darwin', sshArgs: [flag, value] })

    expect(args).toEqual(['-S', 'none'])
    expect(optionValues(args)).not.toContain('ControlMaster=auto')
  })

  it('opts out for an inline forward value such as -L8080:host:80', () => {
    expect(buildFleetSshMultiplexArgs({ platform: 'darwin', sshArgs: ['-L8080:host:80'] })).toEqual(
      ['-S', 'none']
    )
  })

  it('opts out for a clustered forward flag such as -fNL', () => {
    expect(
      buildFleetSshMultiplexArgs({ platform: 'linux', sshArgs: ['-fNL', '5173:127.0.0.1:3000'] })
    ).toEqual(['-S', 'none'])
  })

  it('opts out for -o LocalForward / RemoteForward / DynamicForward config options', () => {
    for (const option of [
      'LocalForward=8080 127.0.0.1:80',
      'RemoteForward 9000 localhost:9000',
      'dynamicforward=1080'
    ]) {
      expect(buildFleetSshMultiplexArgs({ platform: 'darwin', sshArgs: ['-o', option] })).toEqual([
        '-S',
        'none'
      ])
    }
  })

  it('honors the per-target reuse opt-out even without forwards', () => {
    expect(buildFleetSshMultiplexArgs({ platform: 'darwin', connectionReuse: false })).toEqual([
      '-S',
      'none'
    ])
  })

  it('keeps multiplexing when reuse is explicitly allowed', () => {
    expect(
      optionValues(buildFleetSshMultiplexArgs({ platform: 'darwin', connectionReuse: true }))
    ).toContain('ControlMaster=auto')
  })

  it('never multiplexes on Windows, where OpenSSH has no ControlMaster', () => {
    expect(buildFleetSshMultiplexArgs({ platform: 'win32' })).toEqual(['-S', 'none'])
  })

  it('returns a fresh array so callers can splice without corrupting later plans', () => {
    const first = buildFleetSshMultiplexArgs({ platform: 'darwin' })
    first.push('--', 'mutated')
    const second = buildFleetSshMultiplexArgs({ platform: 'darwin' })

    expect(second).not.toContain('mutated')
    expect(second).toHaveLength(8)
  })
})

describe('planFleetSshMultiplex', () => {
  it('reports multiplexed mode with no forwarding options for an ordinary probe', () => {
    expect(planFleetSshMultiplex({ platform: 'darwin', sshArgs: ['-T'] })).toMatchObject({
      mode: 'multiplexed',
      forwardingOptions: []
    })
  })

  it('names the forwarding options that forced the opt-out', () => {
    const plan = planFleetSshMultiplex({
      platform: 'linux',
      sshArgs: ['-N', '-L', '8080:127.0.0.1:80', '-R', '9000:localhost:9000']
    })

    expect(plan.mode).toBe('forwarding-opt-out')
    expect(plan.args).toEqual(['-S', 'none'])
    expect(plan.forwardingOptions).toEqual(['-L 8080:127.0.0.1:80', '-R 9000:localhost:9000'])
  })

  it('reports reuse-disabled ahead of forwarding when the target opted out', () => {
    const plan = planFleetSshMultiplex({
      platform: 'darwin',
      connectionReuse: false,
      sshArgs: ['-L', '1:h:1']
    })

    expect(plan.mode).toBe('reuse-disabled')
    expect(plan.forwardingOptions).toEqual(['-L 1:h:1'])
  })

  it('reports unsupported-platform on Windows even with forwards requested', () => {
    expect(planFleetSshMultiplex({ platform: 'win32', sshArgs: ['-L', '1:h:1'] }).mode).toBe(
      'unsupported-platform'
    )
  })
})

describe('findFleetSshForwardingOptions', () => {
  it('returns nothing for ordinary probe options', () => {
    expect(
      findFleetSshForwardingOptions([
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-p',
        '2222',
        '-i',
        '/keys/id'
      ])
    ).toEqual([])
  })

  it('does not mistake a value that looks like a flag for a forward', () => {
    // Why: `-i -L` names an identity file called "-L"; it is not a forward.
    expect(findFleetSshForwardingOptions(['-i', '-L', '-p', '22'])).toEqual([])
  })

  it('stops scanning at the -- destination terminator', () => {
    expect(findFleetSshForwardingOptions(['-T', '--', 'studio', 'ssh', '-L', '1:h:1'])).toEqual([])
  })

  it('ignores positional arguments before the terminator', () => {
    expect(findFleetSshForwardingOptions(['studio', 'uptime'])).toEqual([])
  })

  it('ignores a bare dash', () => {
    expect(findFleetSshForwardingOptions(['-'])).toEqual([])
  })

  it('finds -L, -R and -D with separate values', () => {
    expect(findFleetSshForwardingOptions(['-L', 'a:b:1', '-R', 'c:d:2', '-D', '1080'])).toEqual([
      '-L a:b:1',
      '-R c:d:2',
      '-D 1080'
    ])
  })

  it('finds inline and clustered forwards', () => {
    expect(findFleetSshForwardingOptions(['-L8080:h:80', '-NfR', '9:h:9'])).toEqual([
      '-L 8080:h:80',
      '-R 9:h:9'
    ])
  })

  it('stops a cluster at the first value-taking flag', () => {
    // Why: in `-oLocalForward=...` the "L" belongs to the -o value, not a flag.
    expect(findFleetSshForwardingOptions(['-oLocalForward=1 h:1'])).toEqual([
      '-o LocalForward=1 h:1'
    ])
    expect(findFleetSshForwardingOptions(['-pL'])).toEqual([])
  })

  it('matches forward config keys case-insensitively with = or whitespace', () => {
    expect(
      findFleetSshForwardingOptions([
        '-o',
        'LOCALFORWARD 1 h:1',
        '-o',
        'RemoteForward=2 h:2',
        '-o',
        'ClearAllForwardings=yes'
      ])
    ).toEqual(['-o LOCALFORWARD 1 h:1', '-o RemoteForward=2 h:2'])
  })

  it('tolerates a trailing value-taking flag with no value', () => {
    expect(findFleetSshForwardingOptions(['-L'])).toEqual(['-L'])
    expect(findFleetSshForwardingOptions(['-o'])).toEqual([])
  })
})

describe('buildFleetSshMasterControlArgs', () => {
  it.each(['check', 'exit'] as const)('targets the fleet master with -O %s', (command) => {
    expect(buildFleetSshMasterControlArgs(command, 'studio', 'darwin')).toEqual([
      '-o',
      'ControlPath=~/.ssh/cm-%C',
      '-O',
      command,
      '--',
      'studio'
    ])
  })

  it('keeps the destination after -- so it cannot be parsed as an option', () => {
    const args = buildFleetSshMasterControlArgs('exit', 'deploy@mw0002', 'linux')

    expect(args?.at(-2)).toBe('--')
    expect(args?.at(-1)).toBe('deploy@mw0002')
  })

  it('refuses a destination that looks like an option', () => {
    expect(buildFleetSshMasterControlArgs('exit', '-oProxyCommand=evil', 'darwin')).toBeNull()
  })

  it('refuses an empty destination', () => {
    expect(buildFleetSshMasterControlArgs('check', '', 'darwin')).toBeNull()
  })

  it('returns null on Windows, where no fleet master exists', () => {
    expect(buildFleetSshMasterControlArgs('check', 'studio', 'win32')).toBeNull()
  })
})
