import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PrStatus } from '../types'
import { buildResolvePrompt, computeCheckCounts, formatRow, isMergeable, nextResolveAction, resolveRepoFromRemote, transitionMessage } from './status'
import type { ResolveDetails } from './status'

const prsAtom = atom({ plugin: 'pr-ci-status', key: 'prs' } as const, [] as PrStatus[])

const POLL_MS = 30_000

// Session-scoped module state (reset on hot reload; the data itself lives in $.state).
let repo = '' // "owner/repo"
let pollTimer: { cancel: () => void } | null = null
let polling = false
let focusedNumber: number | null = null // PR number whose row currently holds the focus ring

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    repo = await resolveRepo($)
    if (pollTimer) pollTimer.cancel()
    pollTimer = $.clock.every(POLL_MS, () => void poll($))
    void poll($)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    const text = e.text.trim()

    const add = /^pr\s+status\s+(\d+)\s*$/i.exec(text)
    if (add) {
      const number = parseInt(add[1], 10)
      if (!repo) return { drop: 'pr-ci-status: no GitHub remote in this repo' }
      void addPr($, number)
      return { drop: `tracking PR #${number}` }
    }

    if (/^pr\s+status\s+clear\s*$/i.test(text)) {
      void update($, prsAtom, () => [])
      return { drop: 'cleared all tracked PRs' }
    }

    return next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The hook failed before answering: still keep control commands off the model.
    const isControl = /^pr\s+status\s+/i.test(String(e.text ?? '').trim())
    return isControl ? { drop: 'pr-ci-status: hook failed' } : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prs = await read($, prsAtom)
    if (prs.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns

    return (
      <Box flexDirection="column">
        {prs.map((p, i) => (
          <Button
            key={`pr-${p.number}`}
            plain
            autoFocus={i === 0 ? true : undefined}
            onPress={() => void openPr($, p.number)}
          >
            <Text color={p.merged || p.mergeable ? 'success' : p.error ? 'error' : undefined}>
              {formatRow(p, false, columns)}
            </Text>
          </Button>
        ))}
        <Box flexDirection="row" gap={2}>
          <Button key="clear" plain dimColor hotkey="x" onPress={() => void clearFocused($)}>
            clear
          </Button>
          <Button key="resolve" plain dimColor hotkey="r" onPress={() => void resolveFocused($)}>
            resolve
          </Button>
        </Box>
      </Box>
    )
  })

  on('ui.focus', { component: 'AbovePrompt' }, ($, e, next) => {
    if (typeof e.element === 'string' && e.element.startsWith('pr-')) {
      focusedNumber = parseInt(e.element.slice(3), 10)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

async function resolveRepo($: EngineInterface): Promise<string> {
  const info = await $.session.repo()
  return resolveRepoFromRemote(info?.remote)
}

async function addPr($: EngineInterface, number: number): Promise<void> {
  if (!repo) return
  const placeholder: PrStatus = {
    number,
    repo,
    title: '…',
    running: 0,
    failed: 0,
    succeeded: 0,
    unresolved: 0,
    merged: false,
    headSha: '',
    mergeable: false,
    resolving: false,
    resolveRounds: 0,
    resolveSha: '',
  }
  await update($, prsAtom, list =>
    list.some(p => p.number === number) ? list : [...list, placeholder],
  )
  const fresh = await fetchPr($, repo, number).catch(err => ({ ...placeholder, error: errMsg(err) }))
  await update($, prsAtom, list => list.map(p => (p.number === number ? fresh : p)))
}

async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const list = await read($, prsAtom)
    if (list.length === 0) return
    if (!repo) repo = await resolveRepo($)
    if (!repo) return
    const results = await Promise.all(
      list.map(p => fetchPr($, repo, p.number).catch(err => ({ ...p, error: errMsg(err) }))),
    )

    // Notify on transitions: a check newly failed, or a PR became ready to merge.
    list.forEach((old, i) => {
      const fresh = results[i]
      if (!fresh) return
      const message = transitionMessage(old, fresh)
      if (message) notify($, message)
    })

    // Drive the resolve loop and carry its state forward.
    const next = list.map((old, i) => resolveNext($, old, results[i]))
    const byNumber = new Map(next.map(r => [r.number, r]))
    await update($, prsAtom, current => current.map(p => byNumber.get(p.number) ?? p))
  } finally {
    polling = false
  }
}

async function fetchPr($: EngineInterface, repo: string, number: number): Promise<PrStatus> {
  const pr = await ghJson($, [`repos/${repo}/pulls/${number}`])
  const title: string = pr?.title ?? ''
  const draft = !!pr?.draft
  const merged = !!pr?.merged
  const mergeableState: string = pr?.mergeable_state ?? ''
  const headSha: string = pr?.head?.sha ?? ''

  let running = 0
  let failed = 0
  let succeeded = 0
  if (headSha) {
    const cr = await ghJson($, [`repos/${repo}/commits/${headSha}/check-runs?per_page=100`])
    ;({ running, failed, succeeded } = computeCheckCounts(cr?.check_runs ?? []))
  }

  let unresolved = 0
  try {
    unresolved = await unresolvedThreads($, repo, number)
  } catch {
    unresolved = 0
  }

  return {
    number,
    repo,
    title,
    running,
    failed,
    succeeded,
    unresolved,
    merged,
    headSha,
    mergeable: isMergeable({ draft, merged, mergeableState, failed, running }),
    resolving: false,
    resolveRounds: 0,
    resolveSha: '',
  }
}

async function unresolvedThreads($: EngineInterface, repo: string, number: number): Promise<number> {
  const [owner, name] = repo.split('/')
  if (!owner || !name) return 0
  const query =
    'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}'
  const res = await ghJson($, [
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `o=${owner}`,
    '-f',
    `r=${name}`,
    '-F',
    `n=${number}`,
  ])
  const nodes: Array<{ isResolved: boolean }> =
    res?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
  return nodes.filter(t => t.isResolved === false).length
}

async function ghJson($: EngineInterface, args: string[]): Promise<any> {
  const res = await $.process.run(['gh', 'api', ...args], { timeoutMs: 20_000 })
  if (res.exitCode !== 0) {
    throw new Error((res.stderr || res.stdout || `gh exited ${res.exitCode}`).trim())
  }
  try {
    return JSON.parse(res.stdout)
  } catch {
    return res.stdout
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function notify($: EngineInterface, text: string): void {
  void $.ui.notify(text, { title: 'PR CI' })
  $.ui.toast(text)
}

function openPr($: EngineInterface, number: number): void {
  if (repo) void $.process.run(['open', `https://github.com/${repo}/pull/${number}`])
}

async function clearFocused($: EngineInterface): Promise<void> {
  const n = focusedNumber
  if (n == null) return
  await update($, prsAtom, list => list.filter(p => p.number !== n))
  focusedNumber = null
}

async function resolveFocused($: EngineInterface): Promise<void> {
  const n = focusedNumber
  if (n == null || !repo) return
  const list = await read($, prsAtom)
  const pr = list.find(p => p.number === n)
  if (!pr) return

  if (pr.resolving) {
    await update($, prsAtom, l =>
      l.map(p => (p.number === n ? { ...p, resolving: false, resolveRounds: 0, resolveSha: '' } : p)),
    )
    $.ui.toast(`stopped resolving PR #${n}`)
    return
  }

  const details = await fetchResolveDetails($, repo, n).catch(
    () => ({ headSha: pr.headSha, failedChecks: [], comments: [] } as ResolveDetails),
  )
  await $.prompt.submit({ text: buildResolvePrompt(repo, n, details, 1) })
  await update($, prsAtom, l =>
    l.map(p =>
      p.number === n
        ? { ...p, resolving: true, resolveRounds: 1, resolveSha: details.headSha || pr.headSha }
        : p,
    ),
  )
  $.ui.toast(`resolving PR #${n} (round 1/3)`)
}

async function fetchResolveDetails($: EngineInterface, repo: string, number: number): Promise<ResolveDetails> {
  const pr = await ghJson($, [`repos/${repo}/pulls/${number}`])
  const headSha: string = pr?.head?.sha ?? ''

  const failedChecks: string[] = []
  if (headSha) {
    const cr = await ghJson($, [`repos/${repo}/commits/${headSha}/check-runs?per_page=100`])
    const seen = new Set<string>()
    for (const r of cr?.check_runs ?? []) {
      if (seen.has(r.name)) continue
      seen.add(r.name)
      const failed =
        r.status === 'completed' &&
        !!r.conclusion &&
        r.conclusion !== 'success' &&
        r.conclusion !== 'neutral' &&
        r.conclusion !== 'skipped'
      if (!failed) continue
      const summary: string = r.output?.summary || r.output?.title || ''
      failedChecks.push(summary ? `${r.name}: ${summary}` : r.name)
    }
  }

  const comments: ResolveDetails['comments'] = []
  const [owner, name] = repo.split('/')
  if (owner && name) {
    const query =
      'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(first:20){nodes{body path}}}}}}}'
    const res = await ghJson($, [
      'graphql',
      '-f', `query=${query}`,
      '-f', `o=${owner}`,
      '-f', `r=${name}`,
      '-F', `n=${number}`,
    ])
    const threads = res?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
    for (const t of threads) {
      if (t.isResolved) continue
      for (const c of t.comments?.nodes ?? []) {
        if (c?.body) comments.push({ path: c.path ?? '', body: c.body })
      }
    }
  }

  return { headSha, failedChecks, comments }
}

async function submitResolvePrompt($: EngineInterface, repo: string, number: number, round: number): Promise<void> {
  const details = await fetchResolveDetails($, repo, number).catch(
    () => ({ headSha: '', failedChecks: [], comments: [] } as ResolveDetails),
  )
  await $.prompt.submit({ text: buildResolvePrompt(repo, number, details, round) })
}

function resolveNext($: EngineInterface, old: PrStatus, fresh: PrStatus): PrStatus {
  const base = { ...fresh, resolving: old.resolving, resolveRounds: old.resolveRounds, resolveSha: old.resolveSha }
  if (!old.resolving || fresh.error) return base

  const action = nextResolveAction(old, fresh)
  if (action.kind === 'done') {
    notify($, `PR #${fresh.number} is green after resolve`)
    return { ...base, resolving: false, resolveRounds: 0, resolveSha: '' }
  }
  if (action.kind === 'submit') {
    void submitResolvePrompt($, repo, fresh.number, action.round)
    return { ...base, resolving: true, resolveRounds: action.round, resolveSha: fresh.headSha }
  }
  if (action.kind === 'confirm') {
    notify($, `PR #${fresh.number} still failing after 3 fix rounds — needs your input`)
    return { ...base, resolving: false, resolveRounds: 0, resolveSha: '' }
  }
  return base
}
