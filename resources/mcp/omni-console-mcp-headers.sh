#!/bin/sh
# OmniConsole omni-console MCP headersHelper (Claude Code `mcpServers.<name>.headersHelper`).
#
# Why a helper instead of `headers`: Claude Code keys a saved MCP login on
# sha256({type,url,headers}) with `headers` expanded, so per-pane ledger ids in
# `headers` gave every pane its own login slot and no login ever held. Helper
# output never enters that key, so one `claude mcp login omni-console` per
# profile holds while the ledger ids still reach every /mcp request.
#
# Contract: print one JSON object of header name -> value on stdout. The ids
# come from the env OmniConsole stamps on each pane; outside the IDE they are
# empty and the console ignores them. Claude Code runs this with cwd = the
# config directory, so nothing here may depend on cwd. POSIX sh, no deps.

json_escape() {
  case $1 in
    *[!A-Za-z0-9_.:-]*)
      # Defensive path: escape backslash and double quote, drop control characters.
      printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
      ;;
    *)
      # Ledger ids (als_…/att_…) take this path: no subprocess, no PATH dependency.
      printf '%s' "$1"
      ;;
  esac
}

session=$(json_escape "${OMNI_LEDGER_SESSION_ID:-}")
attempt=$(json_escape "${OMNI_LEDGER_ATTEMPT_ID:-}")
printf '{"X-Omni-Ledger-Session":"%s","X-Omni-Ledger-Attempt":"%s"}\n' "$session" "$attempt"
