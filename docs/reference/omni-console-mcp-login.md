# omni-console MCP login for Claude profiles

## What OmniConsole writes

On every signed-in **local** spawn, OmniConsole makes sure the Claude profile's `.claude.json` (the one the pane's `CLAUDE_CONFIG_DIR` selects, or the default when unset) has this entry:

```json
"omni-console": {
  "type": "http",
  "url": "https://console.example.com/mcp",
  "headersHelper": "/Applications/OmniConsole.app/Contents/Resources/mcp/omni-console-mcp-headers.sh"
}
```

There is **no `headers` key**. The helper (`resources/mcp/omni-console-mcp-headers.sh`, shipped in the app's `Resources/mcp/`) prints the two session-ledger headers, `X-Omni-Ledger-Session` and `X-Omni-Ledger-Attempt`, from the `OMNI_LEDGER_SESSION_ID` / `OMNI_LEDGER_ATTEMPT_ID` env OmniConsole stamps on each pane. Outside the IDE they are empty and the console ignores them. In a dev build the path points at `<checkout>/resources/mcp/`.

## Why

Claude Code keys a saved MCP login on `name|sha256({type,url,headers})[:16]`, with `headers` taken **after** `${VAR}` expansion (measured on Claude Code 2.1.285). The old entry put the per-pane ids in `headers` as `${OMNI_LEDGER_SESSION_ID:-}` / `${OMNI_LEDGER_ATTEMPT_ID:-}`, so every pane had its own key and no login held. `headersHelper` output is not part of the key, so every profile now has the single key `omni-console|a1f900b4204085b4`, and one login per profile holds across panes and restarts while every `/mcp` request still carries the ledger ids.

## Which entries are rewritten

An entry is OmniConsole's own (and kept current) only when it points at the omnios URL and is either:

- the legacy shape: at most the two ledger headers (as `${…:-}` templates or literal ids), or no headers at all; or
- the current shape: this app's helper (any install path ending in `/mcp/omni-console-mcp-headers.sh`) and no headers.

Only the exact helper value counts as ours: the helper's absolute path, quoted or not, and nothing else. A wrapper such as `/usr/bin/env OMNI_LEDGER_SESSION_ID=… /…/mcp/omni-console-mcp-headers.sh`, extra arguments or a second command make it the user's own entry.

A legacy entry is rewritten to the helper shape on the next local Claude spawn. Anything else is the user's own and never touched: another header name (for example the `X-Omni-Client` pin on `~/.claude.json` and the legacy profiles), a foreign helper, the helper plus static headers, another URL, `enabled: false`, a disable list.

Not changed: the Codex TOML entry (`env_http_headers`; Codex's credential key already ignores them), Gemini and Grok, and every spawn that is not local — SSH / paired-host relay spawns, WSL guests and Windows keep the legacy `headers` shape, and a local helper path is never written to another host. The helper is used only if it is an executable file at a path that outlives the app: a macOS translocated copy, a Linux AppImage mount (`/tmp/.mount_…`) and anything under a temp directory are refused, and the local spawn keeps the legacy shape instead.

## One login per profile, once

After the first local spawn under the new build, each managed Claude profile needs **one** `claude mcp login omni-console` (and one Approve click in the browser). It then holds.

```sh
# a managed or legacy profile: name its directory exactly as OmniConsole pins it
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/omniconsole-ide/claude-accounts/<id>/auth/session" \
  claude mcp login omni-console
CLAUDE_CONFIG_DIR="<same dir>" claude mcp get omni-console      # expect: Connected

# the default profile: the variable must be UNSET, not set to ~/.claude
env -u CLAUDE_CONFIG_DIR claude mcp login omni-console
env -u CLAUDE_CONFIG_DIR claude mcp get omni-console
```

Claude Code keys its Keychain item on the literal `CLAUDE_CONFIG_DIR` string (`src/main/claude/claude-config-dir-pin.ts`), so a login made under a different spelling of the same directory lands where no session looks. Pinned profiles (an `X-Omni-Client` header) are not converted; their key was already stable and their existing login keeps working.

## Stale helper path

The entry records the helper's absolute path. If that path later disappears — a dev checkout that was deleted, an app that was moved or uninstalled — Claude Code cannot run the helper: its debug log (`claude --debug-to-stderr mcp get omni-console`) shows `Error getting headers from headersHelper: … did not return a valid value`, and it still sends its `/mcp` requests, but without the ledger headers (measured on Claude Code 2.1.285), so pages published from that session show no producing session. The login itself is not lost. The next local Claude spawn from an installed OmniConsole rewrites the path to its own helper (the entry is still recognised as ours, and the login key does not change), which repairs it; nothing else needs to be done.

## Stale login slots

The old per-pane keys left stale `omni-console|<hash>` slots in each profile's Keychain item (`Claude Code-credentials-<sha8>`). Claude Code ignores them once the entry has the helper shape. OmniConsole does not read or sweep the Keychain.
