import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * A fake fleet for dispatched seats: `ssh` and `scp` on this process's PATH that run each "host"
 * as a local folder (its own HOME and bin), and fake `claude` / `codex` CLIs there that record
 * what they were given. Files in a host's folder change its behaviour:
 * `lost` refuses every connection, `claude-signed-out` / `claude-api-key` / `codex-api-key` /
 * `codex-signed-out` change the logins, `drop-live` ends the connection with the seat still
 * running, `drop-lost` ends it and loses the host, `stall-live` keeps the seat running silently
 * (each such seat's pid is appended to `stalled`). Like OpenSSH, `ssh` exits 255 on SIGTERM. A
 * Codex seat on a login other than `codex-fresh-auth.json` takes a second to refresh to it (a
 * line in `codex-refreshes`); with a `codex-running` folder every other Codex seat waits up to
 * 5 s for a second one there and writes how many it saw to `codex-overlap`.
 */
export type FakeFleet = {
  root: string
  host: (alias: string) => { state: string; home: string }
  read: (alias: string, file: string) => Promise<string>
  close: () => Promise<void>
}

const SSH = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
alias=$1; shift
state="$FAKE_FLEET_ROOT/hosts/$alias"
if [ ! -d "$state" ] || [ -e "$state/lost" ]; then
  echo "ssh: connect to host $alias port 22: Operation timed out" >&2
  exit 255
fi
HOME="$state/home"; export HOME
PATH="$state/bin:$PATH"; export PATH
# A real SSH session never carries this computer's CODEX_HOME; a leaked one is a real login here.
unset CODEX_HOME
# As OpenSSH does: SIGTERM mid-session (a stop, timeout or stall ending it) exits 255. No exec, so
# the trap stays in this shell.
trap 'exit 255' TERM
/bin/sh -c "$*"
`

const SCP = `#!/bin/sh
recursive=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -r) recursive=-R; shift ;;
    -*) shift ;;
    *) break ;;
  esac
done
local_path() {
  case "$1" in
    *:*)
      state="$FAKE_FLEET_ROOT/hosts/\${1%%:*}"
      if [ ! -d "$state" ] || [ -e "$state/lost" ]; then
        echo "ssh: connect to host \${1%%:*} port 22: Operation timed out" >&2
        return 1
      fi
      printf '%s' "\${1#*:}" ;;
    *) printf '%s' "$1" ;;
  esac
}
from=$(local_path "$1") || exit 255
to=$(local_path "$2") || exit 255
exec cp $recursive "$from" "$to"
`

const CLAUDE = `#!/bin/sh
state="$HOME/.."
case "$1" in
  --version) echo "2.1.285 (Claude Code)"; exit 0 ;;
  auth)
    if [ -e "$state/claude-signed-out" ]; then echo '{"loggedIn": false, "authMethod": "none"}'
    elif [ -e "$state/claude-api-key" ]; then echo '{"loggedIn": true, "authMethod": "api_key"}'
    else echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "seat@example.com"}'; fi
    exit 0 ;;
esac
sid=""; model=""; prev=""
for arg in "$@"; do
  case "$prev" in --session-id) sid=$arg ;; --model) model=$arg ;; esac
  prev=$arg
done
cat > "$state/seat-$sid.prompt"
pwd -P > "$state/seat-$sid.cwd"
env | grep -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|ENABLE_CLAUDEAI_MCP_SERVERS)=' > "$state/seat-$sid.env"
if [ -e "$state/drop-live" ]; then
  for f in "$HOME"/.omni-fleet/workflow-runs/*/attempts/*/pid; do
    [ "$(cat "$f")" = "$$" ] && pidfile=$f
  done
  # A process of its own session, as a seat on another computer is: never in this process group.
  /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "sleep", "30"' </dev/null >/dev/null 2>&1 &
  echo $! > "$pidfile"
  ps -p "$!" -o lstart= > "$(dirname "$pidfile")/started"
  echo "$!" > "$state/orphan"
  echo "Connection to fake closed by remote host." >&2
  exit 255
fi
if [ -e "$state/stall-live" ]; then
  for f in "$HOME"/.omni-fleet/workflow-runs/*/attempts/*/pid; do
    [ "$(cat "$f")" = "$$" ] && pidfile=$f
  done
  /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "sleep", "30"' </dev/null >/dev/null 2>&1 &
  echo $! > "$pidfile"
  ps -p "$!" -o lstart= > "$(dirname "$pidfile")/started"
  echo "$!" >> "$state/stalled"
  exec sleep 30
fi
if [ -e "$state/drop-lost" ]; then
  touch "$state/lost"
  echo "client_loop: send disconnect: Broken pipe" >&2
  exit 255
fi
printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","structured_output":{"answer":"correct"},"result":"correct","modelUsage":{"%s":{}},"usage":{"input_tokens":1,"output_tokens":1}}\\n' "$sid" "$model"
`

const CODEX = `#!/bin/sh
state="$HOME/.."
case "$1" in
  --version) echo "codex-cli 0.159.2"; exit 0 ;;
  login)
    if [ -e "$state/codex-api-key" ]; then echo "Logged in using an API key - sk-proj-***AbCd"
    elif [ -e "$state/codex-signed-out" ]; then echo "Not logged in"
    else echo "Logged in using ChatGPT"; fi
    exit 0 ;;
esac
model=""; effort=""; prev=""
for arg in "$@"; do
  [ "$prev" = "--model" ] && model=$arg
  case "$arg" in model_reasoning_effort=*) effort=$(printf '%s' "\${arg#*=}" | tr -d '"') ;; esac
  prev=$arg
done
cat > /dev/null
[ -L "$CODEX_HOME/auth.json" ] && readlink "$CODEX_HOME/auth.json" > "$state/codex-auth-link"
if [ -e "$state/codex-fresh-auth.json" ] && ! cmp -s "$CODEX_HOME/auth.json" "$state/codex-fresh-auth.json"; then
  case "$(readlink "$CODEX_HOME/auth.json")" in
    "$FAKE_FLEET_ROOT"/*) ;;
    *) echo "fake codex: refusing to rewrite a login outside the fake fleet" >&2; exit 1 ;;
  esac
  echo "$$" >> "$state/codex-refreshes"
  sleep 1
  cat "$state/codex-fresh-auth.json" > "$CODEX_HOME/auth.json"
elif [ -d "$state/codex-running" ]; then
  : > "$state/codex-running/$$"
  i=0
  while [ "$(ls "$state/codex-running" | wc -l)" -lt 2 ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  ls "$state/codex-running" | wc -l | tr -d ' ' >> "$state/codex-overlap"
fi
env | grep -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)=' > "$state/codex.env"
sid="01234567-89ab-4cde-8f01-$(printf '%012d' $$)"
mkdir -p "$CODEX_HOME/sessions/2026/09/30"
printf '{"type":"session_meta","payload":{"id":"%s","session_id":"%s","cli_version":"0.159.2","originator":"codex_exec","model_provider":"openai"}}\\n{"type":"turn_context","payload":{"turn_id":"turn-1","model":"%s","effort":"%s","approval_policy":"never","sandbox_policy":{"type":"read-only"}}}\\n' "$sid" "$sid" "$model" "$effort" > "$CODEX_HOME/sessions/2026/09/30/rollout-$sid.jsonl"
printf '{"type":"thread.started","thread_id":"%s"}\\n' "$sid"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"{\\\\"answer\\\\":\\\\"correct\\\\"}"}}\\n'
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n'
`

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

/** Installs the fake fleet with `aliases` as hosts; `close` restores PATH and removes it. */
export async function createFakeFleet(aliases: readonly string[]): Promise<FakeFleet> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omni-fake-fleet-')))
  await mkdir(join(root, 'bin'))
  await executable(join(root, 'bin', 'ssh'), SSH)
  await executable(join(root, 'bin', 'scp'), SCP)
  for (const alias of aliases) {
    const state = join(root, 'hosts', alias)
    await mkdir(join(state, 'home'), { recursive: true })
    await mkdir(join(state, 'bin'))
    await executable(join(state, 'bin', 'claude'), CLAUDE)
    await executable(join(state, 'bin', 'codex'), CODEX)
    await mkdir(join(state, 'home', '.codex'))
    await writeFile(join(state, 'home', '.codex', 'auth.json'), '{"fake":"login"}')
  }
  const saved = { PATH: process.env.PATH, FAKE_FLEET_ROOT: process.env.FAKE_FLEET_ROOT }
  process.env.PATH = `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`
  process.env.FAKE_FLEET_ROOT = root
  const host = (alias: string) => {
    const state = join(root, 'hosts', alias)
    return { state, home: join(state, 'home') }
  }
  return {
    root,
    host,
    read: (alias, file) => readFile(join(host(alias).state, file), 'utf8'),
    close: async () => {
      process.env.PATH = saved.PATH
      if (saved.FAKE_FLEET_ROOT === undefined) {
        delete process.env.FAKE_FLEET_ROOT
      } else {
        process.env.FAKE_FLEET_ROOT = saved.FAKE_FLEET_ROOT
      }
      await rm(root, { recursive: true, force: true })
    }
  }
}

/** A Codex ChatGPT login's auth.json whose access token expires at `expiresAt`; fixture tokens only. */
export function fakeCodexLogin(expiresAt: number, lastRefresh: unknown = new Date().toISOString()) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) }))
  return JSON.stringify({
    tokens: {
      access_token: ['header', payload.toString('base64url'), 'signature'].join('.'),
      refresh_token: 'fixture-refresh'
    },
    last_refresh: lastRefresh
  })
}
