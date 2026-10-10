# pr-ci-status

A Claude Code mod that shows GitHub PR CI status in an interactive band above the
prompt. Track several PRs at once; each gets one row you can select and clear with
the keyboard. Rows turn green when a PR is ready to merge — the mod never merges.

The whole feature runs outside the model: it uses zero tokens. The trigger is
intercepted before it reaches the LLM, data comes from the `gh` CLI, and rows are
drawn by a `ui.render` hook.

## Install

```bash
/plugin install pr-ci-status --marketplace jeffyfung/claude-mods
```

During development, load it straight from the folder:

```bash
claude --plugin-dir /Users/jeffreyfung/projects/claude-mods
```

## Usage

```
pr status 659        add PR #659 of the current repo to the band
pr status clear      clear every row
```

In the band: `ctrl+x tab` (or click it) focuses the band; `↑`/`↓` (or `Tab`)
move the selection; `Enter` opens the selected PR in your browser; `x` clears
the selected row; `Esc` returns focus to the prompt.

A row shows:

```
#659  fix the login button          ○2 ✗1 ✓5 💬1 ✓
```

- `○` running / pending check runs
- `✗` failed check runs
- `✓` successful check runs
- `💬` unresolved review threads
- green text + trailing `✓` when the PR is ready to merge, `✓ merged` once it's merged
- the selected row is highlighted (inverted)

The status refreshes every 30 seconds and needs the `gh` CLI authenticated
(`gh auth login`). It reads the PR, its check runs, and its unresolved review
threads from the current repository's `origin` remote.

When a watched PR's checks newly fail, or it becomes ready to merge, you get a
native notification (`$.ui.notify`) plus an in-terminal toast.

## Layout

```
.claude-plugin/            plugin manifest + marketplace
hooks/                     hooks module, Button rows, pure helpers, tests
types/                     state contract (PrStatus)
test-fixtures/             example CI workflow for exercising every status
```
