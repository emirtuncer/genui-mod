import { describe, expect, test } from 'claude-code/testing'

import type { GenuiTemplateRun } from '../types'
import { BUILTINS } from './builtins'
import { VITEST } from './fixtures'
import { fingerprint, maxTimeout, parseOutput, resolveCwd, templateView, validateTemplate } from './template-file'

const runOf = (name: string, data: GenuiTemplateRun['data']): GenuiTemplateRun => {
  const template = BUILTINS[name]
  if (template === undefined) throw new Error(`no builtin ${name}`)
  return { name, origin: 'builtin', root: '/project', template, data, errors: [], isLoading: false, updatedAt: 0 }
}

describe('validateTemplate', () => {
  test('the built-in templates are valid', () => {
    for (const template of Object.values(BUILTINS)) expect(validateTemplate(template)).toEqual([])
  })

  test('names each problem', () => {
    expect(validateTemplate({ title: '', sources: { 'b d': { argv: [], parse: 'xml' } }, refreshSeconds: -1 })).toEqual([
      'title: required non-empty string',
      'refreshSeconds: expected a number ≥ 0',
      'sources["b d"]: name must be letters, digits, - or _',
      'sources["b d"].argv: required non-empty array of strings, the first naming a program',
      'sources["b d"].parse: expected "json", "text" or "lines"',
      'tree: required node object',
    ])
  })
})

describe('parseOutput', () => {
  test('json, text and lines', () => {
    expect(parseOutput('r', 'warn: x\n{"a":1}\n', 'json')).toEqual({ value: { a: 1 } })
    expect(parseOutput('r', '  hi \n', 'text')).toEqual({ value: 'hi' })
    expect(parseOutput('r', 'a\r\n\r\nb  \n', 'lines')).toEqual({ value: ['a', 'b'] })
    expect(parseOutput('r', 'nope', 'json')).toEqual({ error: 'r: output is not JSON: nope' })
  })
})

test('resolveCwd', () => {
  expect(resolveCwd('C:/p', undefined)).toBe('C:/p')
  expect(resolveCwd('C:/p', 'web')).toBe('C:/p/web')
  expect(resolveCwd('C:/p', 'D:/other')).toBe('D:/other')
})

test('fingerprint is a stable SHA-256 of canonical JSON', async () => {
  expect(await fingerprint({ a: 1, b: { c: 2, d: [1] } })).toBe(await fingerprint({ b: { d: [1], c: 2 }, a: 1 }))
  expect(await fingerprint({ a: 1 })).not.toBe(await fingerprint({ a: 2 }))
  expect(await fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  expect(await fingerprint(undefined)).toBe(await fingerprint(null))
})

test('review fixes: parseOutput finds payloads in noise', () => {
  expect(parseOutput('r', '{"a":1}\nDone in 2s', 'json')).toEqual({ value: { a: 1 } })
  expect(parseOutput('r', '[INFO] x\n[{"a":1},{"b":2}]', 'json')).toEqual({ value: [{ a: 1 }, { b: 2 }] })
  expect(parseOutput('r', '[INFO] {"a":1}', 'json')).toEqual({ value: { a: 1 } })
})

test('review fixes: validateTemplate argv, reserved names; maxTimeout', () => {
  const base = { title: 't', tree: { type: 'text', text: 'x' } }
  const msg = 'required non-empty array of strings, the first naming a program'
  expect(validateTemplate({ ...base, sources: { a: { argv: [' '], parse: 'text' } } })).toEqual([`sources["a"].argv: ${msg}`])
  expect(validateTemplate({ ...base, sources: { a: { argv: ['x', 'a\u0000b'], parse: 'text' } } })).toEqual([`sources["a"].argv: ${msg}`])
  expect(validateTemplate({ ...base, sources: { now: { argv: ['x'], parse: 'text' } } })).toEqual(['sources["now"]: "now" is reserved'])
  expect(maxTimeout({ title: 't', sources: {}, tree: {} })).toBe(30_000)
})

test('review fixes: a suite that failed to load is shown', () => {
  const data = { ...VITEST, numFailedTests: 0, testResults: [{ name: 'src/broken.test.ts', status: 'failed', message: 'SyntaxError: x', assertionResults: [] }] }
  const { view, problems } = templateView(runOf('tests', { r: data }))
  expect(problems).toEqual([])
  expect(JSON.stringify(view?.tree)).toContain('src/broken.test.ts')
  expect(JSON.stringify(view?.tree)).toContain('SyntaxError')
})

describe('templateView', () => {
  test('fills the tests template from vitest output', () => {
    const { view, problems } = templateView(runOf('tests', { r: VITEST }))
    expect(problems).toEqual([])
    expect(JSON.stringify(view?.tree)).toContain('a adds')
    expect(JSON.stringify(view?.tree)).not.toContain('a subtracts')
  })

  test('fills git and pods', () => {
    expect(templateView(runOf('git', { branch: 'main', sync: '0\t2', changes: [' M a.ts'], log: ['abc fix (2 hours ago)'] })).problems).toEqual([])
    const pod = { metadata: { namespace: 'web', name: 'api-1' }, status: { phase: 'Pending', containerStatuses: [{ restartCount: 4 }] } }
    const { view, problems } = templateView(runOf('pods', { pods: { items: [pod] } }))
    expect(problems).toEqual([])
    expect(JSON.stringify(view?.tree)).toContain('["web","api-1","Pending","4"]')
  })

  test('a run without data draws nothing yet', () => {
    expect(templateView(runOf('tests', undefined))).toEqual({ problems: [] })
  })
})
