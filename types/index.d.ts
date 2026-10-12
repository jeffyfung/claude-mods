export type PrStatus = {
  /** The PR number, as in `pr status 659`. */
  number: number
  /** The repository as `owner/name`. */
  repo: string
  title: string
  /** True once the PR is merged. */
  merged: boolean
  /** The PR's current head commit SHA. */
  headSha: string
  /** Check runs queued or in progress (○). */
  running: number
  /** Check runs that failed, cancelled, timed out, etc. (✗). */
  failed: number
  /** Check runs that succeeded (✓). */
  succeeded: number
  /** Unresolved review threads (💬). */
  unresolved: number
  /** True when the PR is ready to merge (never merges it). */
  mergeable: boolean
  /** True while the resolve loop is driving fixes for this PR. */
  resolving: boolean
  /** Fix rounds submitted so far (capped at 3). */
  resolveRounds: number
  /** The head SHA the last fix prompt was submitted for. */
  resolveSha: string
  /** A fetch error, when the last refresh failed. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-ci-status': { prs: PrStatus[] }
  }
}
