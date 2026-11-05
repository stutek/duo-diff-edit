---
name: duo-diff-edit
description: Edit a file together with the user in Visual Studio Code without touching their buffer. Open the index ↔ buffer diff with a request file, propose edits by writing them into the git index, and let the user accept them block by block. Use when the user asks to write, review or polish a file together, or for "turbo mode" or "duo diff edit".
---

# Duo Diff Edit

The user and you edit the same file. The diff shows the git index (stage) on the left and the user's editor buffer on the right. You never write the file on disk: you write your proposals into the index, and the left side of the diff updates. The user accepts a proposal with **Revert Block** (→, copies the block from the left into the buffer) and stages their own text with **Stage Block** (+), which also rejects your proposal for that block.

Requires git and the Duo Diff Edit extension for Visual Studio Code (https://github.com/stutek/duo-diff-edit). Run the shell commands below in bash (on Windows: Git Bash, which Claude Code uses). Paths in git commands are relative to the repository root.

The mailbox and your working copies live in the same directory the extension uses:

```bash
D="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"   # Linux: RAM (tmpfs); macOS: per-user temp; Git Bash: /tmp is the Windows user temp
```

1. **Open the diff.** Write a file with any name into `$D/duo-diff-edit/`, one line per file: `git <absolute path>` (on Windows `pwd -W` gives the `C:/…` form; `/c/…` also works). The Visual Studio Code window whose workspace holds the path takes the request and deletes it; a file outside git history enters the index empty, so all its content shows as new.
   ```bash
   mkdir -p "$D/duo-diff-edit" && echo "git $(pwd)/notes.md" > "$D/duo-diff-edit/$(date +%s)-$$-$RANDOM"
   ```
2. **Propose.** Take the current index version and its hash, edit the copy, then write it back only if the user has not staged in the meantime:
   ```bash
   C="$D/duo-diff-edit-copies/<session>"; mkdir -p "$C"
   git show :<path> > "$C/<name>"; base=$(git rev-parse :<path>)
   # … edit "$C/<name>" …
   [ "$(git rev-parse :<path>)" = "$base" ] && git update-index --cacheinfo 100644,$(git hash-object -w "$C/<name>"),<path>
   ```
   If the hash differs, the user staged meanwhile: take a fresh copy and redo the edit. The left side refreshes when the Visual Studio Code window has focus.
3. **The user** accepts a block with → and stages their own text with +.
4. **Commit** only when the user asks, and take the saved file (`git commit -- <path>`); proposals the user did not accept are dropped. At the end delete `$C` and stop the watcher (below).

## Review on stage

When the user stages, a part is finished. A watcher on the index wakes you (run it as a background or monitored command and restart it when it times out); on each change it prints `STAGE <path> <hash>`:

```bash
z=; while sleep 2; do n=$(git ls-files -s -- <path>); [ "$n" != "$z" ] && [ -n "$z" ] && echo "STAGE <path> $(cut -d' ' -f2 <<<"$n")"; z=$n; done
```

- The hash of your own proposal (`git hash-object` in step 2) is not the user's stage: skip it.
- **Review:** from the difference between the previous and the new hash (`git diff --word-diff=porcelain <old> <new>`), judge only the staged part, against the project's own criteria, and propose fixes into the index (step 2).
- **Learn:** compare the staged part with your last proposal for the same place: accepted (→), rejected or rewritten. When the user rejects or rewrites the same kind of proposal a second time, record it as a rule or preference in the project's rules file and say so in your answer.
