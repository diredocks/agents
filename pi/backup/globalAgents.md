# Global Instructions

## Commits

Use Conventional Commits: `type(scope): description`.

- Keep the description short and on one line.
- Add a body only for complex changes.

## Tools

- Put temporary files in `/tmp/pi`.
- Never use `grep` or `find`, not the tools and not in bash — use `rg` and `fd`.
- Bash starts in the session cwd — only prefix `cd` when the target differs from `<cwd>`.
- Use `read` for a single file at a known path; use bash when searching, slicing, or chaining commands.
- Use `write` for whole-file rewrites, `edit` for targeted changes; avoid heredocs for file writes.

## Scripts

- Scripts — loops, parsing, multi-step logic — go in `codemode`: JavaScript in a sandbox with no fs, network, or timers, so its only I/O is `tools.*` (`tools.bash`, `tools.read`, `tools.grep`, …).
- Never write a `.py`/`.sh`/`.pl` file and run it with an interpreter.
- Keep plain `bash` to short chained commands.

## Subagents

Manage subtasks with tmux using socket name `pi`:

```sh
tmux -L pi new-session -d -s <name>
tmux -L pi send-keys -t <name> '<command>' Enter
tmux -L pi capture-pane -pt <name>
```
