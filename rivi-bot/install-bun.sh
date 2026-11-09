#!/usr/bin/env bash
# Installs Bun for claude-code-action from the npm registry, and writes its path to the step's
# output `path` for the action's `path_to_bun_executable`. On its own, the action downloads Bun
# from github.com's release downloads, which can fail while the rest of GitHub works: on
# 2026-11-09 they answered 504 while the API did not, and every review failed. The action
# already installs its own dependencies from the registry, so this adds no host the run needs.
#
# A failed download leaves `path` empty, and the action downloads Bun from GitHub as before.
# A download that does not match the integrity pinned here stops the run instead.
set -uo pipefail

# The bun-version that claude-code-action's action.yml pins, at the commit the actions use. When
# that commit moves, move this with it, and each integrity to what
# `npm view @oven/<package>@<version> dist.integrity` prints. CI fails when the two differ.
version=1.4.4
case "$RUNNER_OS/$RUNNER_ARCH" in
  Linux/X64)
    package="bun-linux-x64"
    integrity=sha512-CHbbkmHVM28T1GFq+6GL4Ao4ujwwYwj1CxFFwEFzLanPfNsId9AhbIP0Q4reWuWBkGimUkoQygrK7Rgjtj3vog==
    ;;
  Linux/ARM64)
    package="bun-linux-aarch64"
    integrity=sha512-ZTVtpf9zmHSBVPX1sBwe5agGb/rN34yPGg/Hby8e2Ax2uCUA2URZKlZH7qLntK7qaFJCMXh9v0GWNYN2zINz1w==
    ;;
  *)
    echo "No Bun package pinned for $RUNNER_OS/$RUNNER_ARCH; claude-code-action installs its own."
    exit 0
    ;;
esac

dir="$RUNNER_TEMP/rivi-bot-bun"
tarball="$dir/$package-$version.tgz"
rm -rf "$dir"
mkdir -p "$dir"

if ! curl --fail --silent --show-error --location --retry 4 --retry-all-errors \
  --connect-timeout 10 --max-time 120 --output "$tarball" \
  "https://registry.npmjs.org/@oven/$package/-/$package-$version.tgz"; then
  echo "::warning::Could not download Bun $version from the npm registry; claude-code-action downloads it from GitHub instead."
  exit 0
fi

actual="sha512-$(openssl dgst -sha512 -binary "$tarball" | openssl base64 -A)"
if [ "$actual" != "$integrity" ]; then
  echo "::error::@oven/$package@$version from the npm registry is $actual, not the $integrity pinned in rivi-bot/install-bun.sh."
  exit 1
fi

bun="$dir/bin/bun"
if ! tar -xzf "$tarball" -C "$dir" --strip-components=1 package/bin/bun || [ "$("$bun" --version 2>/dev/null)" != "$version" ]; then
  echo "::warning::Bun $version from the npm registry does not run here; claude-code-action downloads it from GitHub instead."
  exit 0
fi
rm -f "$tarball"

echo "Installed Bun $version from the npm registry at $bun."
echo "path=$bun" >> "$GITHUB_OUTPUT"
