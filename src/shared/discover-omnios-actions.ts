/** Saved answers are read whole; every selected finding goes through its idempotent launcher. */
export function discoverOmniosActionsScript(): string {
  return [
    '#!/bin/sh',
    'set -e',
    'cd "$(dirname "$0")"',
    'page="${1:-1}"',
    'case "$page" in *[!0-9]*|""|0) echo "Invalid page" >&2; exit 2 ;; esac',
    'file=page.html; [ "$page" = 1 ] || file="page-$page.html"',
    '"${ORCA_CLI_COMMAND:-omni}" artifacts status "$file" --json > "answer-$page.json"',
    '"${ORCA_CLI_COMMAND:-omni}" workflow page-picks findings.json --answer "answer-$page.json" --page "$page" --json > "picks-$page.json"',
    `node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for(const f of p.picks) if(f.pick!=="Not now") console.log(f.n+":"+(f.pick==="Start"?"start":"dig"))' "picks-$page.json" > "actions-$page.txt"`,
    'failed=0',
    'while IFS=: read -r n pick; do',
    '  if [ "$pick" = start ]; then',
    '    sh ./start.sh "$n" "contract-$n.json" || failed=1',
    '  else',
    '    who=$(node -e \'const fs=require("fs"); const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const d=(e.result??e).latest; process.stdout.write(d.by.name||d.by.email)\' "answer-$page.json")',
    '    sh ./dig.sh "$n" "dig-$n.md" "words-$n.txt" "$who" || failed=1',
    '  fi',
    'done < "actions-$page.txt"',
    'exit "$failed"',
    ''
  ].join('\n')
}
