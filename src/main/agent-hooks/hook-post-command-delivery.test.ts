import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { buildPosixAgentHookPostCommand } from './hook-post-command'

const TOKEN = 'synthetic-hook-wire-token'
const PANE = 'tab-wire:11111111-1111-4111-8111-111111111111'
const WORKTREE = 'wire café 日本語 😀'
const PAYLOAD = JSON.stringify({
  hook_event_name: 'UserPromptSubmit',
  prompt: 'café 日本語 😀',
  context: 'x'.repeat(8192)
})

// Each old listener intentionally knows only its own header spelling. Executing the
// generated shell proves new producers work across independent host upgrades.
describe.skipIf(process.platform === 'win32')(
  'generated POSIX hook delivery to older listeners',
  () => {
    const servers: Server[] = []
    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()))
            })
        )
      )
    })

    it.each([
      ['x-orca', 'form', '2'],
      ['x-orca', 'raw-json-v1', '2'],
      ['x-orca', 'raw-json-v1', '1'],
      ['x-omni', 'form', '2'],
      ['x-omni', 'raw-json-v1', '2']
    ])(
      'delivers the exact payload and metadata to %s using %s',
      async (prefix, transport, version) => {
        const posts: { headers: IncomingHttpHeaders; body: string }[] = []
        const listener = createServer((req, res) => {
          if (req.headers[`${prefix}-agent-hook-token`] !== TOKEN) {
            res.writeHead(403).end()
            return
          }
          let body = ''
          req.setEncoding('utf8')
          req.on('data', (chunk: string) => {
            body += chunk
          })
          req.on('end', () => {
            posts.push({ headers: req.headers, body })
            res.writeHead(204).end()
          })
        })
        servers.push(listener)
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
        const address = listener.address()
        if (!address || typeof address === 'string') {
          throw new Error('No test listener port')
        }
        const script = [
          'payload=$(cat)',
          'orca_agent_pid=12345',
          'orca_agent_pid_host=local',
          ...buildPosixAgentHookPostCommand('claude')
        ].join('\n')
        const result = await runProcess({
          program: '/bin/bash',
          args: ['-c', script],
          input: PAYLOAD,
          timeoutMs: 10_000,
          env: {
            PATH: process.env.PATH,
            ORCA_AGENT_HOOK_PORT: String(address.port),
            ORCA_AGENT_HOOK_TOKEN: TOKEN,
            ORCA_AGENT_HOOK_TRANSPORT: transport,
            ORCA_PANE_KEY: PANE,
            ORCA_TAB_ID: 'tab-wire',
            ORCA_WORKTREE_ID: WORKTREE,
            ORCA_AGENT_LAUNCH_TOKEN: 'launch-wire',
            ORCA_AGENT_HOOK_ENV: 'production',
            ORCA_AGENT_HOOK_VERSION: version
          }
        })
        expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
        expect(posts).toHaveLength(1)
        if (transport === 'raw-json-v1') {
          expect(posts[0].body).toBe(PAYLOAD)
          expect(posts[0].headers[`${prefix}-agent-hook-meta-encoding`]).toBe('base64')
          expect(
            Buffer.from(
              posts[0].headers[`${prefix}-agent-hook-meta`] as string,
              'base64'
            ).toString()
          ).toBe(
            [
              PANE,
              'tab-wire',
              'launch-wire',
              WORKTREE,
              'production',
              version,
              ...(version === '1' ? [] : ['12345', 'local'])
            ].join('\x1f')
          )
        } else {
          const form = new URLSearchParams(posts[0].body)
          expect(form.get('payload')).toBe(PAYLOAD)
          expect(form.get('paneKey')).toBe(PANE)
          expect(form.get('worktreeId')).toBe(WORKTREE)
          expect(form.get('launchToken')).toBe('launch-wire')
          expect(form.get('agentPid')).toBe('12345')
          expect(form.get('agentPidHost')).toBe('local')
        }
      }
    )
  }
)
