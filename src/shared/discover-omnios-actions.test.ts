import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discoverOmniosActionsScript } from './discover-omnios-actions'

const folders: string[] = []
afterEach(() => {
  for (const f of folders.splice(0)) {
    rmSync(f, { recursive: true, force: true })
  }
})

it('processes all eight picks separately, continues after a refusal, and retries idempotently', () => {
  const folder = mkdtempSync(join(tmpdir(), 'discover-picks-'))
  folders.push(folder)
  writeFileSync(join(folder, 'actions.sh'), discoverOmniosActionsScript())
  const picks = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, key: `k${i}`, pick: 'Start' }))
  const cli = join(folder, 'omni')
  writeFileSync(
    cli,
    `#!/bin/sh\nif [ "$1" = artifacts ]; then echo '{}'; else cat expected.json; fi\n`
  )
  chmodSync(cli, 0o700)
  writeFileSync(join(folder, 'expected.json'), JSON.stringify({ picks }))
  writeFileSync(
    join(folder, 'start.sh'),
    '#!/bin/sh\n[ -f "started-$1" ] && exit 0\n[ "$1" = 2 ] && [ -f refuse ] && exit 2\necho "$1" >> launched.txt\ntouch "started-$1"\n'
  )
  writeFileSync(join(folder, 'refuse'), '')
  const act = () =>
    execFileSync('sh', [join(folder, 'actions.sh'), '1'], {
      env: { ...process.env, ORCA_CLI_COMMAND: cli },
      stdio: 'pipe'
    })
  expect(act).toThrow()
  expect(readFileSync(join(folder, 'launched.txt'), 'utf8').trim().split('\n')).toEqual([
    '1',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8'
  ])
  rmSync(join(folder, 'refuse'))
  act()
  act()
  expect(readFileSync(join(folder, 'launched.txt'), 'utf8').trim().split('\n')).toEqual([
    '1',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '2'
  ])
})
