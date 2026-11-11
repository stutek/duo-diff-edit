---
name: duo-diff-edit
description: Edit a file together with the user in Visual Studio Code, as in Meld - your proposal on the left, their file on the right, blocks copied across either way. Open the diff with a request file, write your proposal into its own private file, and review each time the user saves. Use when the user asks to write, review or polish a file together, for "turbo mode" or "duo diff edit", or to configure what a 📖 click starts (skill, model, effort).
---

# Duo Diff Edit

The user and you edit the same file. The diff shows **your proposal on the left** and **the user's file on the right**, both editable. You never write the user's file: you write only the proposal, and the left side updates at once. The user takes a block of yours with the gutter arrow → or **Copy Block Right** (Alt+→), and puts their own text into your proposal with **Copy Block Left** (Alt+←); on macOS Ctrl+Alt+← and →. Many users also write on the left, as a working surface, and take the whole side over to the right.

Requires the Duo Diff Edit extension for Visual Studio Code (https://github.com/stutek/duo-diff-edit); no git. Run the shell commands below in bash (on Windows: Git Bash, which Claude Code uses).

The mailbox and the proposals live in the directories the extension uses:

```bash
D="${XDG_RUNTIME_DIR:-$HOME/.cache}"   # Linux: RAM (tmpfs), private to the user; elsewhere the home directory
umask 077                              # requests and copies of the user's text stay private
F="$(pwd)/notes.md"                    # the user's file, absolute (Git Bash: /c/Users/…)
P="$D/duo-diff-edit-proposals$F"       # your proposal for it: the file's absolute path under that directory
```

Never use a shared temp directory (`/tmp`) for either: another user could read the copies or plant a link where you write.

1. **Open the diff.** Write a file with any name into `$D/duo-diff-edit/`, one line per file, each ending in a newline: `pair <absolute path>`. The Visual Studio Code window whose workspace holds the path takes the request and deletes it; if no window has it, the focused window opens it after 1.5 s. A proposal that does not exist yet starts as a copy of the file, so nothing differs. If the request file is still there after 3 s, no window took it: tell the user to reload the Visual Studio Code window (**Developer: Reload Window**). A request older than 60 s is dropped. A **📖** click writes the same request.
   ```bash
   mkdir -p "$D/duo-diff-edit" && echo "pair $F" > "$D/duo-diff-edit/$(date +%s)-$$-$RANDOM"
   ```
2. **Propose.** Write the whole proposal anew each round: the user's latest file plus your proposals they have not taken yet. Keep the file's line breaks (one paragraph per line stays one line), so the diff marks only what you changed; write to a copy and move it into place, so the side never shows a half-written file:
   ```bash
   mkdir -p "$(dirname "$P")" && cp "$F" "$P.new"   # … edit "$P.new" …
   mv "$P.new" "$P" && cksum < "$P" | cut -d' ' -f1   # the sum of your own write: its SAVE line is not the user's
   ```
   Do not write while the user works on the left: wait until their last `SAVE left` is at least 5 s old. A failed edit ("modified since read") is the right brake: read again and merge.
3. **The user** takes blocks (→), puts their text into your proposal (←), writes on either side and saves; Visual Studio Code may save on its own every second (`files.autoSave`).
4. **Commit** only when the user asks, and only the user's file; your proposal is never committed. At the end delete it (`rm -f "$P"`) and stop the watcher.

## Review on save

A watcher wakes you (run it as a background or monitored command); it prints one line when a side has not changed for 3 s, so autosave while typing gives one line, not one per second:

```bash
s() { cksum < "$1" 2>/dev/null | cut -d' ' -f1; }
el=$(s "$P"); er=$(s "$F"); cl=$el; cr=$er; tl=0; tr=0
while sleep 1; do
  n=$(s "$P"); if [ "$n" != "$cl" ]; then cl=$n; tl=0; else tl=$((tl+1)); fi
  if [ "$cl" != "$el" ] && [ $tl -ge 3 ]; then echo "SAVE left $cl"; el=$cl; fi
  n=$(s "$F"); if [ "$n" != "$cr" ]; then cr=$n; tr=0; else tr=$((tr+1)); fi
  if [ "$cr" != "$er" ] && [ $tr -ge 3 ]; then echo "SAVE right $cr"; er=$cr; fi
done
```

- `SAVE left` with the sum of your own write: skip it. Any other `SAVE left` is the user's work on your proposal: keep it, and build the next round on it.
- `SAVE right`: the user's file changed (blocks taken, their own text). Judge the change against the project's own criteria, then propose the next round (step 2).
- **Learn:** compare what the user took, rewrote or left with your last proposal for the same place. When they rewrite the same kind of proposal a second time, record it as a rule or preference in the project's rules file and say so in your answer.

## Index mode (git)

The older mode shows the git index (stage) on the left and the user's editor buffer on the right; the user stages their own text with **Stage Block** (+), which also rejects your proposal for that block. Open it with `git <absolute path>` (on Windows `pwd -W` gives the `C:/…` form), or the user right-clicks a file: **Open diff (stage ↔ buffer)**. If no window has the project open, the focused window opens the project's folder in a new window, which takes it. A file outside git history enters the index empty, so all its content shows as new. Paths in git commands are relative to the repository root.

1. **Propose.** Take the current index version and its hash, edit the copy, then write it back only if the user has not staged in the meantime:
   ```bash
   C="$D/duo-diff-edit-copies/<session>"; mkdir -p "$C"
   git show :<path> > "$C/<name>"; base=$(git rev-parse :<path>)
   # … edit "$C/<name>" …
   [ "$(git rev-parse :<path>)" = "$base" ] && git update-index --cacheinfo 100644,$(git hash-object -w "$C/<name>"),<path>
   ```
   If the hash differs, the user staged meanwhile: take a fresh copy and redo the edit. The left side refreshes when the Visual Studio Code window has focus.
2. **Review on stage.** A stage marks a finished part. A watcher prints `STAGE <path> <hash>` on each change; skip the hash of your own proposal, and judge only the staged part (`git diff --word-diff=porcelain <old> <new>`):
   ```bash
   z=; while sleep 2; do n=$(git ls-files -s -- <path>); [ "$n" != "$z" ] && [ -n "$z" ] && echo "STAGE <path> $(cut -d' ' -f2 <<<"$n")"; z=$n; done
   ```
3. **Commit** only when the user asks, and take the saved file (`git commit -- <path>`); proposals the user did not accept are dropped. At the end delete `$C` and stop the watcher.

## Configure: what a 📖 click starts (skill, model, effort)

A 📖 click always opens the diff. It can also start a skill with the file's path as its argument, as if the user typed `/<skill> <path>`. Each setting lives in the one place Claude Code reads it; set them when the user asks, and say what you changed.

| Setting       | Where it lives                                                                    | Values                                                                    |
|---------------|-----------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| Skill         | the user's `~/.claude/settings.json`, `pluginConfigs.<plugin id>.options.skill`   | a skill name as typed after the slash; empty (the default): diff only     |
| Model, effort | the frontmatter of that skill's `SKILL.md`: `model:` and `effort:`                | `model`: as for `/model` (`sonnet`, `opus`, `haiku`, a model ID, `inherit`); `effort`: `low`, `medium`, `high`, `xhigh`, `max` |

- **Plugin id:** `duo-diff-edit@duo-diff-edit` when installed from the marketplace; `duo-diff-edit` (or `duo-diff-edit@inline`) when loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`. Only the user's settings count: Claude Code ignores `pluginConfigs` in a project's `.claude/settings.json`, so a cloned repository cannot set it. The user can also set it in `/config` (row *Skill a 📖 click starts*).
- **Edit the settings file** by merging into it, never by overwriting it: read it, change only `pluginConfigs`, write it back as valid JSON. The new value applies from the next session or `/reload-plugins`.
  ```json
  { "pluginConfigs": { "duo-diff-edit@duo-diff-edit": { "options": { "skill": "turbo" } } } }
  ```
- **Model and effort** apply for the turn the click starts (Claude Code's `model` and `effort` frontmatter); later rounds, each started by the user's save, run on the session's model and effort. With `context: fork` the whole skill runs in a subagent on that model and effort instead, which suits a single review, not a back-and-forth.
- **Build a skill** for the click (the user's own, so its model and effort are theirs to choose): a folder in `~/.claude/skills/` (all projects) or the project's `.claude/skills/`, holding `SKILL.md`:
  ```markdown
  ---
  name: turbo
  description: Duo Diff Edit on a fast model, started by a 📖 click with the file's path.
  model: sonnet
  effort: low
  disable-model-invocation: true
  ---

  Edit $ARGUMENTS together with the user, following the duo-diff-edit:duo-diff-edit skill.
  ```
  Then set `skill` to `turbo`. A skill name is letters, digits, `.`, `_`, `-`, with one optional `plugin:` prefix; anything else, or a path with spaces or quotes, makes the click start nothing and say why.
