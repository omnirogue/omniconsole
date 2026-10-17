import {
  workflowCodexRefreshDueAt,
  workflowCodexRefreshDueWithin
} from './local-workflow-codex-launch'
import {
  workflowFleetShellQuote,
  workflowFleetSsh,
  type WorkflowFleetRun
} from './workflow-fleet-remote-shell'

const LOGIN_READ_TIMEOUT_MS = 10_000

// Runs on the host with perl's core JSON::PP and MIME::Base64: only whether the login rotates, its
// access expiry and its last refresh leave the host, never a token. `{}` when it cannot be read.
const LOGIN_TIMES = `my $a = eval { open my $h, '<', $ARGV[0] or die; local $/; decode_json(<$h>) };
ref $a eq 'HASH' or do { print '{}'; exit };
my $t = $a->{tokens};
ref $t eq 'HASH' && defined $t->{refresh_token} && !ref $t->{refresh_token}
  or do { print encode_json({ rotating => JSON::PP::false }); exit };
my $p = (split /\\./, $t->{access_token} // '')[1] // '';
$p =~ tr{-_}{+/};
my $c = eval { decode_json(decode_base64($p)) };
my $e = ref $c eq 'HASH' ? $c->{exp} : undef;
my $r = $a->{last_refresh};
print encode_json({ rotating => JSON::PP::true, exp => ref $e ? undef : $e, last_refresh => ref $r ? undef : $r });`

/** Reads the login a fleet Codex seat links (`workflowFleetSeatCommand`): the same auth.json. */
export const WORKFLOW_FLEET_CODEX_LOGIN_SCRIPT = [
  'f="${CODEX_HOME:-$HOME/.codex}/auth.json"',
  `exec perl -MJSON::PP -MMIME::Base64 -e ${workflowFleetShellQuote(LOGIN_TIMES)} "$f"`
].join('\n')

/**
 * When the host's Codex login next refreshes, from what the host printed: `null` when it has no
 * rotating refresh token, `undefined` when that cannot be told.
 */
export function workflowFleetCodexRefreshDue(text: string): number | null | undefined {
  let said: { rotating?: unknown; exp?: unknown; last_refresh?: unknown }
  try {
    said = JSON.parse(text) as typeof said
  } catch {
    return undefined
  }
  if (!said || typeof said !== 'object' || typeof said.rotating !== 'boolean') {
    return undefined
  }
  if (!said.rotating) {
    return null
  }
  const exp =
    typeof said.exp === 'number' && Number.isFinite(said.exp) ? said.exp * 1000 : undefined
  return workflowCodexRefreshDueAt(exp, said.last_refresh)
}

/**
 * Whether a Codex call of `withinMs` on the host could refresh its rotating login, read there just
 * before the launch. A host or login that cannot be read counts as due, which keeps that host's
 * Codex calls one at a time.
 */
export async function workflowFleetCodexLoginRefreshesWithin(
  alias: string,
  withinMs: number,
  deps: { run?: WorkflowFleetRun } = {}
): Promise<boolean> {
  const read = await workflowFleetSsh(
    deps,
    alias,
    WORKFLOW_FLEET_CODEX_LOGIN_SCRIPT,
    LOGIN_READ_TIMEOUT_MS,
    4096
  )
  const due =
    read && read.code === 0 && !read.timedOut
      ? workflowFleetCodexRefreshDue(read.stdout.trim())
      : undefined
  return workflowCodexRefreshDueWithin(due, withinMs)
}
