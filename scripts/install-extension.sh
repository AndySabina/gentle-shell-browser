#!/usr/bin/env bash
# Copies extension/ to a Windows folder so Windows Chrome can load it unpacked
# (Chrome does not load unpacked extensions reliably from \\wsl.localhost paths).
#
# On native Linux or macOS (no wslpath), or with GENTLE_CHROME_PLATFORM=linux or
# darwin (a Linux Chrome inside WSL), it hands over to `npm run install-extension`
# (node src/update.ts setup [folder]), which installs for the Chrome on this system.
#
# Usage: scripts/install-extension.sh [windows-target-dir]
#   Default target: %USERPROFILE%\gentle-shell-chrome
#   The target may be a Windows path (C:\Users\me\gentle-shell-chrome) or a WSL path (/mnt/c/...).
#
# Safety: it only writes inside the target, never deletes anything, and refuses a
# non-empty target that is not a previous copy of this extension.
#
# The copy is made by src/update.ts, which also writes build.json and records the
# target so Gentle Shell can update the extension by itself from then on. It also
# writes the native messaging host into <target>-host and registers it under
# HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.gentle.shell (no admin needed),
# so the extension finds Gentle Shell without a pairing code.
#
# Inside a Gentle Shell session PATH may lack the Windows folders and
# WSL_DISTRO_NAME may be unset: cmd.exe and powershell.exe are then looked up in
# C:\Windows\System32, and the helper starts the distribution `wslpath -w /`
# names (printed below). When it names none and the target is on a Windows
# drive, the install stops and asks for WSL_DISTRO_NAME.
set -euo pipefail

NAME="Gentle Shell Browser"
root=$(cd "$(dirname "$0")/.." && pwd)
source_dir="$root/extension"

fail() {
	echo "install-extension: $*" >&2
	exit 1
}

if [ "$#" -gt 1 ]; then
	echo "Usage: $0 [windows-target-dir]" >&2
	exit 2
fi
command -v node >/dev/null || fail "node not found: install Node 22.18 or newer."
case "${GENTLE_CHROME_PLATFORM:-}" in
linux | darwin) exec node "$root/src/update.ts" setup "$@" ;;
esac
command -v wslpath >/dev/null || exec node "$root/src/update.ts" setup "$@"
[ -f "$source_dir/manifest.json" ] || fail "no extension/manifest.json under $root."

if [ "$#" -eq 1 ]; then
	target_arg=$1
else
	# A Gentle Shell session's PATH may lack System32: look there after PATH.
	system32=$(wslpath -u 'C:\Windows\System32' 2>/dev/null || true)
	windows_command() {
		if command -v "$1" 2>/dev/null; then return 0; fi
		if [ -n "$system32" ] && [ -x "$system32/$2" ]; then echo "$system32/$2"; fi
		return 0
	}
	cmd=$(windows_command cmd.exe cmd.exe)
	powershell=$(windows_command powershell.exe WindowsPowerShell/v1.0/powershell.exe)
	# cmd.exe warns about UNC paths when started from a WSL directory, so run it from C:.
	drive_c=$(wslpath -u 'C:\' 2>/dev/null || true)
	drive_c=${drive_c:-/mnt/c}
	if [ -n "$cmd" ]; then
		profile=$(cd "$drive_c" 2>/dev/null && "$cmd" /c echo %USERPROFILE% 2>/dev/null | tr -d '\r')
	elif [ -n "$powershell" ]; then
		profile=$(cd "$drive_c" 2>/dev/null && "$powershell" -NoProfile -Command '$env:USERPROFILE' 2>/dev/null | tr -d '\r')
	else
		fail "neither cmd.exe nor powershell.exe found: pass the target folder explicitly."
	fi
	if [ -z "$profile" ] || [ "$profile" = "%USERPROFILE%" ]; then
		fail "could not read %USERPROFILE%: pass the target folder explicitly."
	fi
	target_arg="$profile\\gentle-shell-chrome"
fi

case "$target_arg" in
[A-Za-z]:\\* | [A-Za-z]:/*) target=$(wslpath -u "$target_arg") ;;
*) target=$target_arg ;;
esac
[ -n "$target" ] || fail "empty target folder."
case "$target" in
/ | /mnt | /mnt/ | /mnt/[a-z] | /mnt/[a-z]/) fail "refusing to copy into $target: choose a dedicated folder." ;;
esac

if [ -e "$target" ] && [ ! -d "$target" ]; then
	fail "$target exists and is not a folder."
fi
if [ -d "$target" ]; then
	if [ "$(cd "$target" && pwd -P)" = "$(cd "$source_dir" && pwd -P)" ]; then
		fail "the target is the source extension/ folder itself."
	fi
	if [ -n "$(ls -A "$target")" ]; then
		if [ ! -f "$target/manifest.json" ] || ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$NAME\"" "$target/manifest.json"; then
			fail "$target is not empty and is not a previous copy of $NAME. Choose an empty or new folder."
		fi
	fi
fi

case "$target" in
/mnt/*) ;;
*) echo "Warning: $target is inside WSL; Chrome may fail to load it from a \\\\wsl.localhost path." >&2 ;;
esac

result=$(node "$root/src/update.ts" install "$target") || exit 1
{ read -r build; read -r host_dir; read -r registry; } <<<"$result"

windows_path=$(wslpath -w "$target" 2>/dev/null || echo "$target")
version=$(grep -Eo '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$source_dir/manifest.json" | grep -Eo '[0-9][^"]*' || true)
host_windows_path=$(wslpath -w "$host_dir" 2>/dev/null || echo "$host_dir")
echo "Copied $NAME ${version:+$version }(build $build) to $windows_path"
echo "Native host written to $host_windows_path"
if [ -z "${WSL_DISTRO_NAME:-}" ]; then
	distro=$(grep -Eo 'wsl\.exe -d [^ ]+' "$host_dir/gentle-shell-host.bat" | cut -d' ' -f3 || true)
	[ -z "$distro" ] || echo "WSL_DISTRO_NAME is not set; the helper starts WSL distribution $distro (from wslpath -w /)."
fi
case "$registry" in
updated) echo "Registry updated: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.gentle.shell" ;;
unchanged) echo "Registry already up to date: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.gentle.shell" ;;
*) echo "Registry not updated: the host folder is not on a Windows drive." >&2 ;;
esac
echo
echo "First time: open chrome://extensions in Chrome, turn on Developer mode,"
echo "press \"Load unpacked\" and choose:"
echo "  $windows_path"
echo
echo "After that first load, Gentle Shell updates the extension by itself whenever it"
echo "connects with an older build. An extension loaded before self-update needs one"
echo "press of the reload icon on the $NAME card in chrome://extensions."
