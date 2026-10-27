#!/usr/bin/env bash
# Regenerates the pictures in docs/images/ from the harness in docs/harness/:
# the real popup and page overlay, with fake, anonymous data.
#
# Usage: scripts/capture-screenshots.sh
#   CHROME=/mnt/c/path/to/chrome.exe overrides the Chrome it runs.
#
# Runs Windows Chrome headless from WSL with a throwaway profile on a temporary
# copy of extension/ and docs/harness/ under the Windows temp folder (Chrome
# cannot read \\wsl.localhost paths reliably). Both are removed at the end.
# It never touches your Chrome profile.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/docs/images"

fail() {
	echo "capture-screenshots: $*" >&2
	exit 1
}

command -v wslpath >/dev/null || fail "wslpath not found: run this inside WSL."
command -v powershell.exe >/dev/null || fail "powershell.exe not found: run this inside WSL with Windows interop."

chrome=${CHROME:-}
if [ -z "$chrome" ]; then
	for candidate in "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
		if [ -x "$candidate" ]; then
			chrome=$candidate
			break
		fi
	done
fi
[ -n "$chrome" ] && [ -x "$chrome" ] || fail "Chrome not found: set CHROME to chrome.exe."

windows_temp=$(cd /mnt/c && powershell.exe -NoProfile -Command '$env:TEMP' | tr -d '\r')
[ -n "$windows_temp" ] || fail "could not read the Windows temp folder."
scratch=$(mktemp -d "$(wslpath -u "$windows_temp")/gentle-shell-docs.XXXXXX")
cleanup() {
	rm -rf "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/docs" "$scratch/shots" "$scratch/profile" "$out"
cp -R "$root/extension" "$scratch/extension"
cp -R "$root/docs/harness" "$scratch/docs/harness"

profile=$(wslpath -w "$scratch/profile")
base_url="file:///$(wslpath -w "$scratch/docs/harness" | tr '\\' '/')"

# shot <name> <page?query> <width> <height> <scale>
shot() {
	local name=$1 page=$2 width=$3 height=$4 scale=$5
	local file="$scratch/shots/$name.png"
	(cd /mnt/c && "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
		--disable-extensions --allow-file-access-from-files --force-device-scale-factor="$scale" \
		--user-data-dir="$profile" --window-size="$width,$height" --virtual-time-budget=3000 \
		--screenshot="$(wslpath -w "$file")" "$base_url/$page" >/dev/null 2>&1) || true
	[ -s "$file" ] || fail "Chrome did not write $name.png."
	cp "$file" "$out/$name.png"
	chmod 644 "$out/$name.png"
	echo "wrote docs/images/$name.png"
}

shot popup-connected "popup.html?connected" 320 468 2
shot popup-remember "popup.html?remember" 320 622 2
shot popup-never "popup.html?never" 320 482 2
shot popup-helper-missing "popup.html?helper-missing" 320 381 2
shot overlay "overlay.html" 1280 720 1
shot overlay-waiting "overlay.html?waiting" 1280 720 1
