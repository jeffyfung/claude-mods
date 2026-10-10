import type { PrStatus } from '../types'

export type CheckRun = {
  name: string
  status: string | null
  conclusion: string | null
}

export function truncate(s: string, n: number): string {
  if (n <= 0) return ''
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

/**
 * Maps GitHub check-runs (deduped by name, latest wins) to the three counts the
 * row shows. `running` = queued + in_progress (○); `failed` = completed with a
 * non-neutral failure conclusion (✗); `succeeded` = completed success (✓).
 */
export function computeCheckCounts(runs: ReadonlyArray<CheckRun>): {
  running: number
  failed: number
  succeeded: number
} {
  let running = 0
  let failed = 0
  let succeeded = 0
  const seen = new Set<string>()
  for (const r of runs) {
    if (seen.has(r.name)) continue
    seen.add(r.name)
    if (r.status === 'queued' || r.status === 'in_progress') {
      running++
    } else if (r.status === 'completed') {
      if (r.conclusion === 'success') succeeded++
      else if (r.conclusion && r.conclusion !== 'neutral' && r.conclusion !== 'skipped') failed++
    }
  }
  return { running, failed, succeeded }
}

export function isMergeable(input: {
  draft: boolean
  merged: boolean
  mergeableState: string
  failed: number
  running: number
}): boolean {
  return (
    !input.draft &&
    !input.merged &&
    input.mergeableState === 'clean' &&
    input.failed === 0 &&
    input.running === 0
  )
}

/**
 * One row of the band: cursor, `#number`, right-aligned counts. Truncates the
 * title so the whole row fits `width` cells.
 */
export function formatRow(pr: PrStatus, selected: boolean, width: number): string {
  const cursor = selected ? '▸' : ' '
  const head = `#${pr.number}`
  const counts = `○${pr.running} ✗${pr.failed} ✓${pr.succeeded} 💬${pr.unresolved}`
  const ready = pr.mergeable ? ' ✓' : ''
  const error = pr.error ? ' ⚠' : ''
  const tail = `${counts}${ready}${error}`
  const fixed = `${cursor} ${head}  `.length + tail.length
  const avail = Math.max(4, width - fixed)
  const title = truncate(pr.title || '…', avail)
  return `${cursor} ${head}  ${title.padEnd(avail)}${tail}`
}

/** `owner/repo` from an origin remote URL, or '' when it is not GitHub. */
export function resolveRepoFromRemote(remote: string | null | undefined): string {
  const m = (remote ?? '').match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/)
  return m ? `${m[1]}/${m[2]}` : ''
}

/**
 * The notification to raise for a watched PR, or null when nothing changed:
 * a check newly failed, or the PR became ready to merge.
 */
export function transitionMessage(old: PrStatus, fresh: PrStatus): string | null {
  if (old.failed === 0 && fresh.failed > 0) {
    return `PR #${fresh.number}: ${fresh.failed} check${fresh.failed === 1 ? '' : 's'} failing`
  }
  if (!old.mergeable && fresh.mergeable) {
    return `PR #${fresh.number}: ready to merge`
  }
  return null
}
