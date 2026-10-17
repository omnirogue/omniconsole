#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an OmniConsole install dir — never delete an unrelated
# /usr/bin/omni-ide a user or other package may own.
set -e

link="/usr/bin/omni-ide"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/OmniConsole/*|/opt/omniconsole/*|/opt/omni-ide/*|/opt/Orca/*|/opt/orca-ide/*|/opt/orca/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
