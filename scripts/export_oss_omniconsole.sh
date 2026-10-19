#!/usr/bin/env bash
# Stage the public OmniConsole repository (github.com/omnirogue/omniconsole) from a committed
# ref, then prove the staged tree carries no private markers.
#
#   bash scripts/export_oss_omniconsole.sh [--ref <git-ref>] [--force] [DEST]
#   bash scripts/export_oss_omniconsole.sh --check [DIR]
#
# Export mode reads the private config in config/oss-export/ (never exported) and defaults DEST
# to /tmp/omnirogue-oss-staging/omniconsole. --check scans DIR (default: this checkout) with
# the generic markers plus the private ones when that config is present.
set -euo pipefail

usage() { sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CONFIG_DIR="$REPO_ROOT/config/oss-export"
DEFAULT_DEST=/tmp/omnirogue-oss-staging/omniconsole
MODE=export
REF=HEAD
FORCE=0
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --ref)
      [ $# -ge 2 ] || { echo "--ref needs a value" >&2; exit 2; }
      REF=$2
      shift
      ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) TARGET=$1 ;;
  esac
  shift
done

command -v perl >/dev/null || { echo "perl is required" >&2; exit 2; }

# Why perl: one regex dialect (lookbehind, \K, binary-safe) on macOS, Linux and Git Bash.
# Generic patterns ship publicly; estate-specific ones come from the private markers file and,
# when Tailscale is running, this machine's own tailnet addresses and MagicDNS suffix. Fixture
# addresses in 100.64.0.0/10 are legitimate, so only real tailnet addresses are markers.
VERIFY_PL=$(cat <<'PERL'
use strict;
use warnings;
use File::Find;
my ($root, @files) = @ARGV;
my @patterns = (
  ['tailnet-hostname', qr/[a-z0-9-]+\.tail(?!1234\.)[0-9a-f]{4,}\.ts\.net/i],
  ['tunnel-hostname', qr/[a-z0-9-]+\.(?:trycloudflare|cfargotunnel)\.com/i],
);
for my $file (@files) {
  open my $fh, '<', $file or die "cannot read $file: $!\n";
  while (my $line = <$fh>) {
    chomp $line;
    $line =~ s/\r$//;
    next if $line =~ /^\s*(?:#|$)/;
    push @patterns, ["$file:$.", qr/$line/i];
  }
}
my $any = join '|', map { "(?:$_->[1])" } @patterns;
$any = qr/$any/;
my ($scanned, @hits) = (0);
find({ no_chdir => 1, wanted => sub {
  if (-d $_ && $_ ne $root && /\/\.git$/) { $File::Find::prune = 1; return; }
  return if -l $_ || !-f _;
  $scanned++;
  open my $fh, '<:raw', $_ or die "cannot read $_: $!\n";
  local $/;
  my $bytes = <$fh>;
  return unless defined $bytes && $bytes =~ $any;
  my $rel = substr($_, length($root) + 1);
  for my $p (@patterns) {
    next unless $bytes =~ $p->[1];
    my $start = $-[0] > 30 ? $-[0] - 30 : 0;
    (my $excerpt = substr($bytes, $start, 90)) =~ s/[^\x20-\x7e]/ /g;
    push @hits, "$rel [$p->[0]] ...$excerpt...";
  }
}}, $root);
print "Scanned $scanned files for ", scalar(@patterns), " marker patterns.\n";
if (@hits) {
  print STDERR "FORBIDDEN MARKERS FOUND (", scalar(@hits), "):\n";
  print STDERR "  $_\n" for @hits[0 .. ($#hits < 199 ? $#hits : 199)];
  exit 1;
}
print "Forbidden markers: 0\n";
PERL
)

TRANSFORM_PL=$(cat <<'PERL'
use strict;
use warnings;
use File::Find;
my ($root, $exclude_file, $subs_file, $rewritten_file) = @ARGV;
# Why: these bytes are hashed or compared byte-for-byte (skill manifests, pnpm patches, plugin
# trees, shell-wrapper snapshots); they must be clean at source, never rewritten here.
my $pinned = qr{^(?:skills/|resources/skills/|resources/plugins/|config/patches/|src/main/__fixtures__/shell-wrapper-snapshots/)};

sub glob_to_regex {
  my ($glob) = @_;
  my $dir = $glob =~ s{/$}{};
  my $re = join '', map {
    $_ eq '**' ? '.*' : $_ eq '*' ? '[^/]*' : $_ eq '?' ? '[^/]' : quotemeta($_)
  } split /(\*\*|\*|\?)/, $glob;
  return $dir ? qr{^$re/} : qr{^$re$};
}

my @excludes;
open my $ex, '<', $exclude_file or die "cannot read $exclude_file: $!\n";
while (my $line = <$ex>) {
  chomp $line;
  $line =~ s/\r$//;
  $line =~ s/^\s+|\s+$//g;
  next if $line eq '' || $line =~ /^#/;
  push @excludes, { glob => $line, re => glob_to_regex($line), hits => 0 };
}
my @rules;
open my $sf, '<', $subs_file or die "cannot read $subs_file: $!\n";
while (my $line = <$sf>) {
  chomp $line;
  $line =~ s/\r$//;
  next if $line =~ /^\s*(?:#|$)/;
  my ($re, $rep) = split /\t/, $line, 2;
  die "substitution line $. needs <regex><TAB><replacement>\n" unless defined $rep;
  push @rules, { line => $., re => qr/$re/, rep => $rep, hits => 0 };
}
my $any = join '|', map { "(?:$_->{re})" } @rules;
$any = qr/$any/;

my @paths;
find({ no_chdir => 1, wanted => sub {
  return if -d $_ && !-l $_;
  push @paths, $_;
}}, $root);

my ($removed, $rewritten, $stripped) = (0, 0, 0);
my (@refused, @rewritten);
for my $path (sort @paths) {
  my $rel = substr($path, length($root) + 1);
  if (my @matched = grep { $rel =~ $_->{re} } @excludes) {
    $_->{hits}++ for @matched;
    unlink $path or die "cannot remove $rel: $!\n";
    $removed++;
    next;
  }
  next if -l $path || !-f $path;
  open my $in, '<:raw', $path or die "cannot read $rel: $!\n";
  my $bytes = do { local $/; <$in> };
  close $in;
  next if !defined $bytes || index(substr($bytes, 0, 8192), "\0") >= 0;
  my $text = $bytes;
  my $omitted = ($text =~ s{[ \t]*<!-- oss-export:omit -->.*?<!-- /oss-export:omit -->[ \t]*(?:\r?\n(?:[ \t]*\r?\n)?|\z)}{}gs);
  $stripped++ if $omitted;
  if ($text =~ $any) {
    for my $rule (@rules) {
      my $count = ($text =~ s/$rule->{re}/$rule->{rep}/g);
      $rule->{hits} += $count if $count;
    }
  }
  next if $text eq $bytes;
  if ($rel =~ $pinned) {
    push @refused, $rel;
    next;
  }
  open my $out, '>:raw', $path or die "cannot write $rel: $!\n";
  print {$out} $text;
  close $out or die "cannot write $rel: $!\n";
  $rewritten++;
  push @rewritten, $rel;
}
finddepth({ no_chdir => 1, wanted => sub { rmdir $_ if -d $_ && !-l $_ && $_ ne $root } }, $root);

if (@refused) {
  print STDERR "Refusing to rewrite byte-pinned files; clean them at source:\n";
  print STDERR "  $_\n" for @refused;
  exit 1;
}
open my $list, '>', $rewritten_file or die "cannot write $rewritten_file: $!\n";
print {$list} "$_\0" for @rewritten;
close $list;
my @unused = grep { !$_->{hits} } @excludes;
print STDERR "warning: exclude pattern matched nothing: $_->{glob}\n" for @unused;
printf "Excluded %d files; stripped omit blocks in %d; rewrote %d files with %d substitutions.\n",
  $removed, $stripped, $rewritten, eval { my $n = 0; $n += $_->{hits} for @rules; $n };
printf "  substitution line %d: %d\n", $_->{line}, $_->{hits} for grep { $_->{hits} } @rules;
PERL
)

# Required public surfaces: license lineage, canonical repository links and community files.
verify_public_surface() {
  local dir=$1 failed=0
  require_text() {
    if ! grep -F -q -- "$2" "$dir/$1" 2>/dev/null; then
      echo "MISSING: $1 must contain: $2" >&2
      failed=1
    fi
  }
  require_text LICENSE 'Copyright (c) 2026 OmniRogue Inc.'
  require_text LICENSE 'Copyright (c) 2026 Lovecast Inc.'
  require_text package.json '"homepage": "https://github.com/omnirogue/omniconsole"'
  require_text README.md 'https://github.com/omnirogue/omniconsole'
  require_text src/shared/omni-project-repo.ts "OMNI_PROJECT_REPO = 'omnirogue/omniconsole'"
  require_text src/shared/omnisi-oss-ecosystem.ts "repository: 'omnirogue/omniseek'"
  for file in .github/CONTRIBUTING.md .github/SECURITY.md .github/CODE_OF_CONDUCT.md; do
    [ -f "$dir/$file" ] || { echo "MISSING: $file" >&2; failed=1; }
  done
  if [ "$MODE" = export ] && [ -e "$dir/config/oss-export" ]; then
    echo "LEAK: private config/oss-export was exported" >&2
    failed=1
  fi
  local env_files
  env_files=$(find "$dir" -path "$dir/.git" -prune -o -name '.env*' -print | head -5)
  if [ -n "$env_files" ]; then
    echo "LEAK: environment files exported:" >&2
    echo "$env_files" >&2
    failed=1
  fi
  return $failed
}

private_markers() {
  [ -f "$CONFIG_DIR/private-markers.txt" ] && echo "$CONFIG_DIR/private-markers.txt"
  return 0
}

# Writes this machine's tailnet IPv4 addresses and MagicDNS suffix as marker patterns.
write_tailnet_markers() {
  local out=$1 ts json
  : >"$out"
  for ts in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
    command -v "$ts" >/dev/null 2>&1 || continue
    json=$("$ts" status --json 2>/dev/null) || continue
    printf "%s" "$json" | perl -MJSON::PP -e '
      my $d = eval { decode_json(join "", <STDIN>) } or exit 0;
      my %seen;
      for my $node ($d->{Self} // {}, values %{ $d->{Peer} // {} }) {
        for my $ip (@{ $node->{TailscaleIPs} // [] }) {
          print "(?<![0-9.])\Q$ip\E(?![0-9])\n" if $ip =~ /^[0-9.]+$/ && !$seen{$ip}++;
        }
      }
      (my $suffix = $d->{MagicDNSSuffix} // "") =~ s/\.$//;
      print "\Q$suffix\E\n" if $suffix =~ /\.ts\.net$/;
    ' >"$out"
    break
  done
  if [ -s "$out" ]; then
    echo "Including $(wc -l <"$out" | tr -d ' ') markers from this machine's tailnet."
  fi
}

TAILNET_MARKERS=$(mktemp "${TMPDIR:-/tmp}/omniconsole-tailnet.XXXXXX")
WORK=""
trap 'rm -rf "$TAILNET_MARKERS" ${WORK:+"$WORK"}' EXIT
write_tailnet_markers "$TAILNET_MARKERS"

if [ "$MODE" = check ]; then
  DIR=${TARGET:-$REPO_ROOT}
  DIR=$(cd "$DIR" && pwd)
  [ -f "$CONFIG_DIR/private-markers.txt" ] ||
    echo "note: private marker list absent; checking generic markers only"
  # shellcheck disable=SC2046
  perl -e "$VERIFY_PL" -- "$DIR" "$TAILNET_MARKERS" $(private_markers)
  verify_public_surface "$DIR"
  echo "Check passed: $DIR"
  exit 0
fi

for file in exclude-paths.txt private-substitutions.tsv private-markers.txt; do
  [ -f "$CONFIG_DIR/$file" ] || {
    echo "Export needs the private config $CONFIG_DIR/$file (it is never exported)." >&2
    exit 2
  }
done

DEST=${TARGET:-$DEFAULT_DEST}
case "$DEST" in
  /*) ;;
  *) DEST="$(pwd)/$DEST" ;;
esac
DEST=${DEST%/}
refuse_dest() {
  echo "Refusing unsafe destination: ${DEST:-/}${1:+ ($1)}" >&2
  exit 2
}
# Why: --force deletes everything in DEST, so compare symlink-resolved paths, not spellings.
case "$DEST/" in
  /) refuse_dest "it is the filesystem root" ;;
  *//* | */./* | */../*) refuse_dest "use a normalized path without . or .. segments" ;;
esac
real_path() {
  local dir=$1 rest=""
  while [ ! -d "$dir" ]; do
    rest="/$(basename "$dir")$rest"
    dir=$(dirname "$dir")
  done
  dir=$(cd "$dir" && pwd -P)
  printf '%s%s\n' "${dir%/}" "$rest"
}
DEST=$(real_path "$DEST")
REAL_REPO=$(cd "$REPO_ROOT" && pwd -P)
REAL_HOME=$(cd "${HOME:-/}" && pwd -P)
for protected in / "$REAL_HOME" "$REAL_REPO"; do
  case "$protected/" in
    "$DEST"/ | "$DEST"/*) refuse_dest "it is or contains $protected" ;;
  esac
done
case "$DEST" in
  "$REAL_REPO"/*) refuse_dest "it is inside this checkout" ;;
esac
if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" | grep -v '^\.git$' || true)" ]; then
  if [ "$FORCE" != 1 ]; then
    echo "Destination $DEST is not empty; pass --force to replace its files (its .git is kept)." >&2
    exit 2
  fi
  grep -q '"name": "omniconsole-ide"' "$DEST/package.json" 2>/dev/null ||
    refuse_dest "--force only replaces an earlier OmniConsole export"
fi

SHA=$(git -C "$REPO_ROOT" rev-parse --verify "$REF^{commit}")
if [ "$REF" = HEAD ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "warning: uncommitted changes are not exported; exporting committed $SHA" >&2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/omniconsole-export.XXXXXX")
mkdir -p "$WORK/tree"
git -C "$REPO_ROOT" archive --format=tar "$SHA" | tar -x -C "$WORK/tree"

perl -e "$TRANSFORM_PL" -- "$WORK/tree" \
  "$CONFIG_DIR/exclude-paths.txt" "$CONFIG_DIR/private-substitutions.tsv" "$WORK/rewritten"

# Why: a substitution that changes a string's length can change how oxfmt wraps the line.
OXFMT=""
if [ -x "$REPO_ROOT/node_modules/.bin/oxfmt" ]; then
  OXFMT="$REPO_ROOT/node_modules/.bin/oxfmt"
elif command -v oxfmt >/dev/null; then
  OXFMT=oxfmt
fi
perl -0ne 'print "$_" if /\.(?:[cm]?[jt]sx?)\0$/' "$WORK/rewritten" >"$WORK/rewritten-code"
if [ ! -s "$WORK/rewritten-code" ]; then
  :
elif [ -n "$OXFMT" ]; then
  (cd "$WORK/tree" && xargs -0 "$OXFMT" --write <"$WORK/rewritten-code" >/dev/null)
  echo "Formatted $(tr -cd '\0' <"$WORK/rewritten-code" | wc -c | tr -d ' ') rewritten code files with oxfmt."
else
  echo "warning: oxfmt not found (run pnpm install); rewritten code files were not reformatted" >&2
fi

STAGED="$WORK/tree"
find "$STAGED" \( -name .git -o -name node_modules -o -name '.env*' -o -name .DS_Store \
  -o -name '*.orig' -o -name '*.rej' -o -name scratchpad -o -name .scratch \) -prune -exec rm -rf {} +
rm -rf "$STAGED/out" "$STAGED/dist"

# Why: validate the staged tree first so a failed scan never replaces the last good export.
perl -e "$VERIFY_PL" -- "$STAGED" "$TAILNET_MARKERS" "$CONFIG_DIR/private-markers.txt"
verify_public_surface "$STAGED"

mkdir -p "$DEST"
if command -v rsync >/dev/null; then
  rsync -a --delete --exclude=/.git/ "$STAGED/" "$DEST/"
else
  find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  (cd "$STAGED" && tar -cf - .) | (cd "$DEST" && tar -xf -)
fi
echo "Exported $(git -C "$REPO_ROOT" rev-parse --short=12 "$SHA") to $DEST"
