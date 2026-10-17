import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import {
  workflowFleetShellQuote,
  workflowFleetSsh,
  type WorkflowFleetRun
} from './workflow-fleet-remote-shell'

export const WORKFLOW_FLEET_RUNS_FOLDER = '.omni-fleet/workflow-runs'
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const MAX_BYTES = 2 * 1024 ** 3

/** Only finished runs qualify; a live or unreadable pid protects the entire folder. */
export function workflowFleetSweepScript(
  home: string,
  limits: { maxAgeSeconds: number; maxBytes: number } = {
    maxAgeSeconds: MAX_AGE_SECONDS,
    maxBytes: MAX_BYTES
  }
): string {
  return `perl - ${workflowFleetShellQuote(`${home}/${WORKFLOW_FLEET_RUNS_FOLDER}`)} <<'PERL'
use strict; use warnings; use File::Find; use File::Path qw(remove_tree);
my $root = shift; exit 0 unless -d $root && !-l $root;
opendir(my $dh, $root) or die "read fleet runs: $!";
my @runs; my $total = 0;
for my $name (readdir $dh) {
  next if $name =~ /^\\./;
  my $dir = "$root/$name"; next unless -d $dir && !-l $dir;
  my $bytes = 0;
  find({ no_chdir => 1, wanted => sub { $bytes += -s $_ if -f $_ && !-l $_; } }, $dir);
  $total += $bytes;
  next unless -f "$dir/.finished";
  my $safe = 1;
  if (-d "$dir/attempts") {
    opendir(my $ah, "$dir/attempts") or next;
    for my $attempt (readdir $ah) {
      next if $attempt =~ /^\\./;
      my $path = "$dir/attempts/$attempt";
      if (!-d $path || -l $path) { $safe = 0; next; }
      open(my $fh, '<', "$path/pid") or do { $safe = 0; next; };
      my $pid = <$fh> // ''; chomp $pid;
      if ($pid !~ /^[1-9][0-9]*$/ || kill(0, $pid) || $!{EPERM}) { $safe = 0; }
    }
  }
  push @runs, [$dir, $bytes, (stat "$dir/.finished")[9]] if $safe;
}
for my $run (sort { $a->[2] <=> $b->[2] } @runs) {
  next if time - $run->[2] < ${limits.maxAgeSeconds} && $total <= ${limits.maxBytes};
  remove_tree($run->[0]); $total -= $run->[1] unless -e $run->[0];
}
PERL`
}

export async function discardWorkflowFleetDispatch(
  placement: WorkflowPlacement,
  deps: { run?: WorkflowFleetRun } = {}
): Promise<void> {
  const { dispatch, host } = placement
  if (
    !dispatch ||
    !host?.ssh ||
    !dispatch.root.startsWith(`${dispatch.home}/${WORKFLOW_FLEET_RUNS_FOLDER}/`)
  ) {
    return
  }
  const removed = await workflowFleetSsh(
    deps,
    host.ssh,
    `rm -rf -- ${workflowFleetShellQuote(dispatch.root)} && printf removed`,
    30_000
  )
  if (removed?.code !== 0 || removed.stdout.trim() !== 'removed') {
    throw new Error(`Could not remove the refused fleet run folder on ${host.name}.`)
  }
}

export async function finishWorkflowFleetDispatch(placement: WorkflowPlacement): Promise<void> {
  if (!placement.dispatch || !placement.host?.ssh) {
    return
  }
  const result = await workflowFleetSsh(
    {},
    placement.host.ssh,
    `touch ${workflowFleetShellQuote(`${placement.dispatch.root}/.finished`)}`,
    10_000
  )
  if (result?.code !== 0) {
    throw new Error(`Could not mark the fleet run finished on ${placement.host.name}.`)
  }
}
