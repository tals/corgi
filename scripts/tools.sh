# Pinned tools that download into .tools on first use, checked against their
# checksums; scripts/zig and scripts/ghostty-host source this. Sets root, the
# checkout, and platform (macos, linux) and arch (aarch64, x86_64).
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -s)" in
    Darwin) platform=macos ;;
    *) platform=$(uname -s | tr '[:upper:]' '[:lower:]') ;;
esac
case "$(uname -m)" in
    arm64) arch=aarch64 ;;
    *) arch=$(uname -m) ;;
esac

# fetch WHAT URL SUM FOLDER: downloads URL, checks it against SUM, and
# unpacks the archive's FOLDER into .tools.
fetch() {
    printf 'Downloading %s into %s/.tools\n' "$1" "$root" >&2
    mkdir -p "$root/.tools"
    work=$(mktemp -d "$root/.tools/.download.XXXXXX")
    trap 'rm -rf "$work"' EXIT
    # curl's meter shows size, speed and time left; logs only need errors.
    if [ -t 2 ]; then progress=; else progress=--silent; fi
    curl -fSL --retry 3 $progress -o "$work/archive" "$2"
    echo "$3  $work/archive" | shasum -a 256 -c - >/dev/null
    printf 'Extracting %s\n' "$1" >&2
    case $2 in
        *.tar.xz) tar -xJf "$work/archive" -C "$work" ;;
        *) tar -xzf "$work/archive" -C "$work" ;;
    esac
    # Another build may have finished the same download first.
    mv "$work/$4" "$root/.tools/" 2>/dev/null || [ -d "$root/.tools/$4" ]
    rm -rf "$work"
    trap - EXIT
}

# main_copy PATH: sets shared to the main checkout's .tools/PATH when this is
# a linked worktree of it and that file runs.
main_copy() {
    common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
    case $common in */.git) ;; *) return 1 ;; esac
    shared=${common%/.git}/.tools/$1
    [ "$shared" != "$root/.tools/$1" ] && [ -x "$shared" ]
}
