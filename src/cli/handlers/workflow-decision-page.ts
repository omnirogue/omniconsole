import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import type { DiscoverOmniosRun } from '../../shared/discover-omnios-page'
import { DISCOVER_OMNIOS_MAX_FINDINGS } from '../../shared/discover-omnios-page'
import { discoverOmniosPage } from '../../shared/discover-omnios-page-html'
import { discoverOmniosPicks } from '../../shared/discover-omnios-picks'

export const WORKFLOW_DECISION_PAGE_HANDLERS: Record<string, CommandHandler> = {
  'workflow render-page': async (ctx) => {
    const path = ctx.flags.get('file')
    if (typeof path !== 'string') {
      throw new RuntimeClientError('invalid_argument', 'Give findings.json')
    }
    const file = resolve(ctx.cwd, path)
    const run: DiscoverOmniosRun = JSON.parse(await readFile(file, 'utf8'))
    const pages = Math.max(1, Math.ceil(run.findings.length / DISCOVER_OMNIOS_MAX_FINDINGS))
    const files: string[] = []
    for (let page = 1; page <= pages; page++) {
      const output = join(dirname(file), page === 1 ? 'page.html' : `page-${page}.html`)
      await writeFile(output, discoverOmniosPage(run, page), { mode: 0o600 })
      files.push(output)
    }
    console.log(JSON.stringify({ files }))
  },
  'workflow page-picks': async (ctx) => {
    const path = ctx.flags.get('file'),
      answer = ctx.flags.get('answer')
    if (typeof path !== 'string' || typeof answer !== 'string') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Give findings.json and --answer status.json'
      )
    }
    const run = JSON.parse(await readFile(resolve(ctx.cwd, path), 'utf8'))
    const envelope = JSON.parse(await readFile(resolve(ctx.cwd, answer), 'utf8'))
    const status = envelope.result ?? envelope
    console.log(
      JSON.stringify(discoverOmniosPicks(run, status, Number(ctx.flags.get('page') ?? 1)))
    )
  }
}
