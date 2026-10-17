import type { GenuiJson, GenuiNode, GenuiTemplate, GenuiTemplateRun, GenuiTemplateSource, GenuiView } from '../types'
import { fillRoot } from './bind'
import { validate } from './schema'

export const NAME = /^[A-Za-z0-9_-]{1,64}$/
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 600_000
const RESERVED = new Set(['now', 'form', '__proto__', 'constructor', 'prototype'])
const PARSES: GenuiTemplateSource['parse'][] = ['json', 'text', 'lines']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Checks a template file's shape (not its tree's bindings, which only data can check). */
export function validateTemplate(raw: unknown): string[] {
  if (!isObject(raw)) return ['template: expected a JSON object']
  const problems: string[] = []
  if (typeof raw.title !== 'string' || raw.title === '') problems.push('title: required non-empty string')
  if (raw.description !== undefined && typeof raw.description !== 'string') problems.push('description: expected a string')
  if (raw.refreshSeconds !== undefined && !(typeof raw.refreshSeconds === 'number' && raw.refreshSeconds >= 0)) {
    problems.push('refreshSeconds: expected a number ≥ 0')
  }
  if (!isObject(raw.sources) || Object.keys(raw.sources).length === 0) {
    problems.push('sources: required object with at least one source')
  } else {
    for (const [name, source] of Object.entries(raw.sources)) {
      const at = `sources[${JSON.stringify(name)}]`
      if (!NAME.test(name)) problems.push(`${at}: name must be letters, digits, - or _`)
      else if (RESERVED.has(name)) problems.push(`${at}: "${name}" is reserved`)
      if (!isObject(source)) {
        problems.push(`${at}: expected an object`)
        continue
      }
      if (!Array.isArray(source.argv) || source.argv.length === 0 || !source.argv.every(arg => typeof arg === 'string' && !arg.includes('\u0000')) || String(source.argv[0]).trim() === '') {
        problems.push(`${at}.argv: required non-empty array of strings, the first naming a program`)
      }
      if (!PARSES.includes(source.parse as GenuiTemplateSource['parse'])) problems.push(`${at}.parse: expected "json", "text" or "lines"`)
      if (source.timeoutMs !== undefined && !(typeof source.timeoutMs === 'number' && source.timeoutMs > 0 && source.timeoutMs <= MAX_TIMEOUT_MS)) {
        problems.push(`${at}.timeoutMs: expected 1 to ${MAX_TIMEOUT_MS}`)
      }
      if (source.cwd !== undefined && typeof source.cwd !== 'string') problems.push(`${at}.cwd: expected a string`)
      for (const flag of ['allowFailure', 'manual']) {
        if (source[flag] !== undefined && typeof source[flag] !== 'boolean') problems.push(`${at}.${flag}: expected a boolean`)
      }
    }
  }
  if (!isObject(raw.tree)) problems.push('tree: required node object')
  return problems
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  }
  return value
}

/** SHA-256 hex of a value's canonical JSON (keys sorted): what an approval is keyed by. */
export async function fingerprint(value: unknown): Promise<string> {
  const text = JSON.stringify(canonical(value ?? null))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A source's working directory: absolute as given, else under the session root. */
export function resolveCwd(root: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return root
  if (/^([A-Za-z]:)?[\\/]/.test(cwd)) return cwd
  return `${root}/${cwd}`
}

/** The index of the bracket closing the one at `from`, skipping strings; -1 if none. */
function matchingClose(text: string, from: number): number {
  let depth = 0
  let inString = false
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** A command's stdout as data; JSON is found among log noise before or after it. */
export function parseOutput(name: string, stdout: string, parse: GenuiTemplateSource['parse']): { value?: GenuiJson; error?: string } {
  if (parse === 'text') return { value: stdout.trim() }
  if (parse === 'lines') return { value: stdout.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line !== '') }
  const lineStarts: number[] = []
  const others: number[] = []
  for (const match of stdout.matchAll(/[{[]/g)) {
    const at = match.index ?? 0
    const before = stdout.slice(stdout.lastIndexOf('\n', at - 1) + 1, at)
    ;(before.trim() === '' ? lineStarts : others).push(at)
  }
  try {
    return { value: JSON.parse(stdout) as GenuiJson }
  } catch {
    /* look for the payload among noise */
  }
  for (const from of [...lineStarts, ...others]) {
    const end = matchingClose(stdout, from)
    if (end < 0) continue
    try {
      return { value: JSON.parse(stdout.slice(from, end + 1)) as GenuiJson }
    } catch {
      continue
    }
  }
  return { error: `${name}: output is not JSON: ${stdout.trim().slice(0, 200) || '(empty)'}` }
}

/** The longest any of a template's sources may run. */
export const maxTimeout = (template: GenuiTemplate) =>
  Math.max(DEFAULT_TIMEOUT_MS, ...Object.values(template.sources).map(source => source.timeoutMs ?? DEFAULT_TIMEOUT_MS))

/** A run's tree filled with its data and checked; no view until the first data arrives. */
export function templateView(run: GenuiTemplateRun): { view?: GenuiView; problems: string[] } {
  if (run.data === undefined) return { problems: [] }
  let tree: unknown
  try {
    tree = fillRoot(run.template.tree, { ...run.data, now: run.updatedAt })
  } catch (error) {
    return { problems: [(error as Error).message] }
  }
  const problems = validate(tree, { isTemplate: true })
  if (problems.length > 0) return { problems }
  return {
    view: { id: `template:${run.name}`, title: run.template.title, tree: tree as GenuiNode, awaitResponse: false, placement: 'pane' },
    problems: [],
  }
}
