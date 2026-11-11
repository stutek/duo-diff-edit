---
name: duo-diff-edit
description: Edit a file together with the user in Visual Studio Code without touching their buffer. Open the index ↔ buffer diff with a request file, propose edits by writing them into the git index, and let the user accept them block by block. Use when the user asks to write, review or polish a file together, for "turbo mode" or "duo diff edit", or to configure what a 📖 click starts (skill, model, effort).
---

# Duo Diff Edit

The user and you edit the same file. The diff shows the git index (stage) on the left and the user's editor buffer on the right. You never write the file on disk: you write your proposals into the index, and the left side of the diff updates. The user accepts a proposal with **Revert Block** (→, copies the block from the left into the buffer) and stages their own text with **Stage Block** (+), which also rejects your proposal for that block.

Requires git and the Duo Diff Edit extension for Visual Studio Code (https://github.com/stutek/duo-diff-edit). Run the shell commands below in bash (on Windows: Git Bash, which Claude Code uses). Paths in git commands are relative to the repository root.

The mailbox and your working copies live in the same directory the extension uses:

```bash
D="${XDG_RUNTIME_DIR:-$HOME/.cache}"   # Linux: RAM (tmpfs), private to the user; elsewhere the home directory
umask 077                              # requests and copies of the user's text stay private
```

Never use a shared temp directory (`/tmp`) for either: another user could read the copies or plant a link where you write.

1. **Open the diff.** Write a file with any name into `$D/duo-diff-edit/`, one line per file, each ending in a newline: `git <absolute path>` (on Windows `pwd -W` gives the `C:/…` form; `/c/…` also works). The Visual Studio Code window whose workspace holds the path takes the request and deletes it; if no window has the project open, the focused window opens the project's folder in a new window, which takes it. A file outside git history enters the index empty, so all its content shows as new. If the request file is still there after 3 s, no window took it: tell the user to reload the Visual Studio Code window (**Developer: Reload Window**). A request older than 60 s is dropped.
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
- **Model and effort** apply for the turn the click starts (Claude Code's `model` and `effort` frontmatter); later rounds, each started by the user's stage, run on the session's model and effort. With `context: fork` the whole skill runs in a subagent on that model and effort instead, which suits a single review, not a back-and-forth.
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
