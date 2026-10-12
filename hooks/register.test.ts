import { expect, test } from 'claude-code/testing'

import { buildResolvePrompt, computeCheckCounts, formatRow, isMergeable, nextResolveAction, resolveRepoFromRemote, transitionMessage, truncate } from './status'
import type { PrStatus } from '../types'

test('computeCheckCounts maps statuses and dedupes by name', () => {
  const counts = computeCheckCounts([
    { name: 'lint', status: 'completed', conclusion: 'success' },
    { name: 'test', status: 'completed', conclusion: 'failure' },
    { name: 'build', status: 'in_progress', conclusion: null },
    { name: 'deploy', status: 'queued', conclusion: null },
    { name: 'lint', status: 'in_progress', conclusion: null }, // duplicate: ignored
  ])
  expect(counts).toEqual({ running: 2, failed: 1, succeeded: 1 })
})

test('computeCheckCounts ignores neutral and skipped conclusions', () => {
  const counts = computeCheckCounts([
    { name: 'a', status: 'completed', conclusion: 'neutral' },
    { name: 'b', status: 'completed', conclusion: 'skipped' },
    { name: 'c', status: 'completed', conclusion: 'cancelled' },
  ])
  expect(counts).toEqual({ running: 0, failed: 1, succeeded: 0 })
})

test('isMergeable requires clean state and green checks', () => {
  const ok = { draft: false, merged: false, mergeableState: 'clean', failed: 0, running: 0 }
  expect(isMergeable(ok)).toBe(true)
  expect(isMergeable({ ...ok, draft: true })).toBe(false)
  expect(isMergeable({ ...ok, merged: true })).toBe(false)
  expect(isMergeable({ ...ok, mergeableState: 'unstable' })).toBe(false)
  expect(isMergeable({ ...ok, failed: 1 })).toBe(false)
  expect(isMergeable({ ...ok, running: 1 })).toBe(false)
})

test('truncate adds an ellipsis only past the limit', () => {
  expect(truncate('hello', 10)).toBe('hello')
  expect(truncate('hello world', 6)).toBe('hello…')
  expect(truncate('abc', 0)).toBe('')
})

test('resolveRepoFromRemote parses https and ssh GitHub remotes only', () => {
  expect(resolveRepoFromRemote('https://github.com/jeffyfung/claude-mods.git')).toBe(
    'jeffyfung/claude-mods',
  )
  expect(resolveRepoFromRemote('git@github.com:jeffyfung/claude-mods.git')).toBe(
    'jeffyfung/claude-mods',
  )
  expect(resolveRepoFromRemote('https://gitlab.com/a/b.git')).toBe('')
  expect(resolveRepoFromRemote(null)).toBe('')
})

test('transitionMessage flags newly failing and newly mergeable PRs only', () => {
  const base: PrStatus = {
    number: 659,
    repo: 'o/r',
    title: 't',
    running: 0,
    failed: 0,
    succeeded: 3,
    unresolved: 0,
    merged: false,
    headSha: '',
    mergeable: false,
    resolving: false,
    resolveRounds: 0,
    resolveSha: '',
  }
  expect(transitionMessage(base, { ...base, failed: 1 })).toBe('PR #659: 1 check failing')
  expect(transitionMessage(base, { ...base, failed: 2 })).toBe('PR #659: 2 checks failing')
  expect(transitionMessage(base, { ...base, mergeable: true })).toBe('PR #659: ready to merge')

  expect(transitionMessage(base, base)).toBe(null)
  expect(transitionMessage({ ...base, failed: 1 }, { ...base, failed: 1 })).toBe(null)
  expect(transitionMessage({ ...base, failed: 1 }, { ...base, failed: 2 })).toBe(null)
  expect(transitionMessage({ ...base, mergeable: true }, { ...base, mergeable: true })).toBe(null)
})

test('formatRow shows all counts, the ready marker, and truncates to width', () => {
  const pr: PrStatus = {
    number: 659,
    repo: 'o/r',
    title: 'a very long pull request title',
    running: 2,
    failed: 1,
    succeeded: 5,
    unresolved: 1,
    merged: false,
    headSha: '',
    mergeable: true,
    resolving: false,
    resolveRounds: 0,
    resolveSha: '',
  }
  const row = formatRow(pr, false, 40)
  expect(row).toContain('#659')
  expect(row).toContain('○2')
  expect(row).toContain('✗1')
  expect(row).toContain('✓5')
  expect(row).toContain('💬1')
  expect(row.endsWith('✓')).toBe(true) // ready marker
  expect(row.length).toBeLessThanOrEqual(40)

  const notReady = formatRow({ ...pr, mergeable: false }, false, 40)
  expect(notReady.endsWith('💬1')).toBe(true)
})

test('formatRow marks a merged PR', () => {
  const merged: PrStatus = {
    number: 660,
    repo: 'o/r',
    title: 't',
    running: 0,
    failed: 0,
    succeeded: 0,
    unresolved: 0,
    merged: true,
    headSha: '',
    mergeable: false,
    resolving: false,
    resolveRounds: 0,
    resolveSha: '',
  }
  expect(formatRow(merged, false, 40)).toContain('✓ merged')
})

test('buildResolvePrompt lists failing checks and review comments', () => {
  const prompt = buildResolvePrompt('o/r', 659, {
    headSha: '',
    failedChecks: ['lint: missing semicolon', 'test: 3 failures'],
    comments: [{ path: 'src/foo.ts', body: 'use a const here' }],
  })
  expect(prompt).toContain('PR #659')
  expect(prompt).toContain('lint: missing semicolon')
  expect(prompt).toContain('test: 3 failures')
  expect(prompt).toContain('src/foo.ts: use a const here')
})

test('buildResolvePrompt handles an empty PR', () => {
  const prompt = buildResolvePrompt('o/r', 659, { headSha: '', failedChecks: [], comments: [] })
  expect(prompt).toContain('No failing checks or unresolved review comments were found.')
})

test('nextResolveAction drives the 3-round cap', () => {
  const mk = (over: Partial<PrStatus> = {}): PrStatus => ({
    number: 659,
    repo: 'o/r',
    title: 't',
    running: 0,
    failed: 1,
    succeeded: 0,
    unresolved: 0,
    merged: false,
    headSha: 'shaB',
    mergeable: false,
    resolving: true,
    resolveRounds: 1,
    resolveSha: 'shaA',
    ...over,
  })

  expect(nextResolveAction(mk(), mk())).toEqual({ kind: 'submit', round: 2 })
  expect(nextResolveAction(mk({ resolveRounds: 3 }), mk())).toEqual({ kind: 'confirm' })
  expect(nextResolveAction(mk({ resolveSha: 'shaB' }), mk())).toEqual({ kind: 'wait' })
  expect(nextResolveAction(mk(), mk({ failed: 0 }))).toEqual({ kind: 'done' })
  expect(nextResolveAction(mk(), mk({ failed: 0, running: 1 }))).toEqual({ kind: 'wait' })
})

test('formatRow shows the resolve marker', () => {
  const resolving: PrStatus = {
    number: 661,
    repo: 'o/r',
    title: 't',
    running: 0,
    failed: 1,
    succeeded: 0,
    unresolved: 0,
    merged: false,
    headSha: '',
    mergeable: false,
    resolving: true,
    resolveRounds: 2,
    resolveSha: '',
  }
  expect(formatRow(resolving, false, 40)).toContain('⟳2/3')
})

test('pr status clear is dropped before it reaches the model', async $ => {
  const result = await $.prompt.submit({ text: 'pr status clear' })
  expect('drop' in result).toBe(true)
})

