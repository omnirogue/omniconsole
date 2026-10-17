import {
  encodeWindowsPowerShellHookCommand,
  getWindowsPowerShellExecutablePath,
  WINDOWS_POWERSHELL_HOOK_SWITCHES
} from './windows-powershell-hook-launcher'
import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from '../../shared/agent-hook-prompt-reply-limit'

// Why: BeforeAgent consumes listener instructions; status-only hooks can discard replies through curl.
function buildPromptPostReplyPowerShell(source: 'gemini' | 'codex'): string {
  const eventName = source === 'gemini' ? 'BeforeAgent' : 'UserPromptSubmit'
  return [
    "$ErrorActionPreference='Stop'; $WarningPreference='SilentlyContinue'; $answer='{}'",
    'try {',
    // Why: a first-use module search can outlive the hook deadline on Windows with a cold cache.
    "  $PSModuleAutoLoadingPreference='None'",
    '  Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop',
    '  $utf8=[System.Text.UTF8Encoding]::new($false,$true)',
    '  $stdin=[System.IO.StreamReader]::new([Console]::OpenStandardInput(),$utf8,$false)',
    '  $payload=$stdin.ReadToEnd()',
    '  if (-not $payload.Trim()) { throw "Empty hook payload" }',
    '  $event=ConvertFrom-Json -InputObject $payload -ErrorAction Stop',
    `  $beforeAgent=$payload.TrimStart().StartsWith('{') -and $event -is [pscustomobject] -and $event.hook_event_name -is [string] -and $event.hook_event_name -ceq '${eventName}'`,
    '  $form=@{paneKey=$env:ORCA_PANE_KEY;tabId=$env:ORCA_TAB_ID;launchToken=$env:ORCA_AGENT_LAUNCH_TOKEN;worktreeId=$env:ORCA_WORKTREE_ID;env=$env:ORCA_AGENT_HOOK_ENV;version=$env:ORCA_AGENT_HOOK_VERSION;payload=$payload}',
    "  $body=($form.GetEnumerator() | ForEach-Object { $_.Key+'='+[System.Net.WebUtility]::UrlEncode([string]$_.Value) }) -join '&'",
    '  $bytes=$utf8.GetBytes($body)',
    '  $port=[int]$env:ORCA_AGENT_HOOK_PORT',
    '  if ($port -lt 1 -or $port -gt 65535) { throw "Invalid hook port" }',
    `  $request=[System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/hook/${source}")`,
    "  $request.Method='POST'; $request.ContentType='application/x-www-form-urlencoded'",
    '  $request.Proxy=$null; $request.AllowAutoRedirect=$false',
    '  $request.Timeout=1500; $request.ReadWriteTimeout=1500; $request.ContentLength=$bytes.Length',
    "  $request.Headers['X-Orca-Agent-Hook-Token']=$env:ORCA_AGENT_HOOK_TOKEN",
    "  $request.Headers['X-Omni-Agent-Hook-Token']=$env:ORCA_AGENT_HOOK_TOKEN",
    '  $stream=$request.GetRequestStream()',
    '  try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }',
    '  $response=$request.GetResponse()',
    '  try {',
    '    if ($beforeAgent -and [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300) {',
    '      $reader=[System.IO.StreamReader]::new($response.GetResponseStream(),$utf8,$false)',
    `      $buffer=[char[]]::new(${AGENT_HOOK_PROMPT_REPLY_MAX_BYTES + 1})`,
    '      try { $n=$reader.ReadBlock($buffer,0,$buffer.Length) } finally { $reader.Dispose() }',
    '      $raw=[string]::new($buffer,0,$n)',
    `      if ($utf8.GetByteCount($raw) -gt ${AGENT_HOOK_PROMPT_REPLY_MAX_BYTES}) { throw "Reply too large" }`,
    // Why: ConvertFrom-Json alone accepts extensions, so constrain the complete reply to strict JSON.
    String.raw`      $text='"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"'`,
    String.raw`      $e='"hookEventName"\s*:\s*"${eventName}"'; $c='"additionalContext"\s*:\s*'+$text`,
    String.raw`      $shape='\A\s*{\s*"hookSpecificOutput"\s*:\s*{\s*(?:'+$e+'\s*,\s*'+$c+'|'+$c+'\s*,\s*'+$e+')\s*}\s*}\s*\z'`,
    String.raw`      $shape=$shape.Replace('\s','[ \t\r\n]')`,
    '      if ($raw -cmatch $shape) {',
    '        ConvertFrom-Json -InputObject $raw -ErrorAction Stop | Out-Null',
    // Why: PowerShell escaping must not expand a valid listener reply beyond its byte budget.
    '        $answer=$raw.Trim()',
    '      }',
    '    }',
    '  } finally { $response.Dispose() }',
    "} catch { $answer='{}' }",
    // Why: write UTF-8 bytes directly; PowerShell's console code page can corrupt instructions.
    '$output=[System.Text.Encoding]::UTF8.GetBytes($answer+[Environment]::NewLine)',
    '[Console]::OpenStandardOutput().Write($output,0,$output.Length)',
    'exit 0'
  ]
    .map((line) => line.trim())
    .join('\n')
}

export function buildWindowsPromptHookScript(source: 'gemini' | 'codex'): string {
  const encoded = encodeWindowsPowerShellHookCommand(buildPromptPostReplyPowerShell(source), {
    bypassExecutionPolicy: false
  })
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    // Why: outside an OmniConsole pane the caller may never close stdin (#11549).
    'if not defined ORCA_PANE_KEY goto :orca_gemini_neutral_reply',
    'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" >nul 2>nul',
    'if not defined ORCA_AGENT_HOOK_PORT goto :orca_gemini_neutral_reply',
    'if not defined ORCA_AGENT_HOOK_TOKEN goto :orca_gemini_neutral_reply',
    'if not defined ORCA_PANE_KEY goto :orca_gemini_neutral_reply',
    `"${getWindowsPowerShellExecutablePath()}" ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encoded} 2>nul`,
    // Why: a missing/blocked interpreter still owes Gemini a parseable neutral reply.
    'if errorlevel 1 goto :orca_gemini_neutral_reply',
    'exit /b 0',
    ':orca_gemini_neutral_reply',
    'echo {}',
    'exit /b 0',
    ''
  ].join('\r\n')
}

export function buildWindowsGeminiHookScript(): string {
  return buildWindowsPromptHookScript('gemini')
}
