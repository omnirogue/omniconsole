import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('typesafe-evaluation-results', { recursive: true })
await build({
  entryPoints: ['config/scripts/run-decision-recipe.mjs'],
  outfile: 'typesafe-evaluation-results/jev-decide.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
  legalComments: 'eof'
})
