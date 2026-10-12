# Test fixtures

`ci.yml` is an example GitHub Actions workflow that produces every CI state the
mod renders, so you can verify the display end to end.

- `pass` → green tick (✓)
- `fail` → red cross (✗)
- `slow` → circle (○) for ~90s while it sleeps, then green
- `queued` → circle (○) while it waits for `slow`, then green

## Try it

1. Copy `ci.yml` into a throwaway GitHub repo at `.github/workflows/ci.yml`.
2. Push a branch and open a pull request. Note the PR number.
3. In a repo that has the mod loaded (`claude --plugin-dir /path/to/claude-mods`),
   type:

   ```
   pr status <number>
   ```

   A row appears above the prompt with `#<number>`, the title, and the counts.
4. Press `ctrl+x tab` (or click the row area) to focus the band, then `↑`/`↓`
   to select a row, `Enter` to open it, and `x` to clear it.
5. Watch the row turn green once `fail` is fixed and `slow`/`queued` finish —
   the mod never merges, it only signals readiness.
