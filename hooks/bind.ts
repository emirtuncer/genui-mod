export type Scope = Record<string, unknown>

/** What a missing value draws as inside text. */
export const MISSING = '—'
export const EACH_LIMIT = 200

const WHOLE = /^\{\{([^{}]*)\}\}$/
const ANY = /\{\{([^{}]*)\}\}/g
const SPREAD = '__genuiSpread'
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype'])
const TOTAL_LIMIT = 2000

/** Fields that keep a number or boolean; every other bound field becomes text. */
const TYPED_KEYS = new Set(['max', 'seconds', 'gap', 'padding', 'bold', 'dim', 'italic', 'border'])

/** Reads `a.b[0].c` out of the scope; undefined where any step is missing. */
export function lookup(scope: Scope, path: string): unknown {
  const steps = path.trim().match(/[^.[\]]+/g) ?? []
  if (steps.length === 0) return undefined
  let value: unknown = scope
  for (const step of steps) {
    if (value === null || value === undefined) return undefined
    if (BLOCKED.has(step)) return undefined
    if (Array.isArray(value) && /^\d+$/.test(step)) value = value[Number(step)]
    else if (typeof value === 'object' && Object.hasOwn(value, step)) value = (value as Record<string, unknown>)[step]
    else return undefined
  }
  return value
}

const unescape = (arg: string) => arg.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\s/g, ' ')

/** A field of a list item; `field` empty means the item itself. */
const fieldOf = (item: unknown, field: string) => (field === '' ? item : lookup({ item }, `item.${field}`))

/** `k=v` or `k!=v`, compared as text. */
const fieldTest = (arg: string) => {
  const match = /^([^!=]+)(!?=)(.*)$/.exec(arg)
  if (match === null) throw new Error(`expected field=value, got "${arg}"`)
  const [, field = '', op, want] = match
  return (item: unknown) => {
    const got = fieldOf(item, field.trim())
    return (got === undefined || got === null ? '' : String(got)) === want ? op === '=' : op !== '='
  }
}

const asList = (value: unknown, filter: string): unknown[] => {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  throw new Error(`${filter}: expected a list`)
}

const isBlank = (value: unknown) => value === undefined || value === null || value === ''

export const FILTERS: Record<string, (value: unknown, arg: string) => unknown> = {
  length: value => (Array.isArray(value) || typeof value === 'string' ? value.length : 0),
  first: value => asList(value, 'first')[0],
  last: value => asList(value, 'last').at(-1),
  count: (value, arg) => asList(value, 'count').filter(fieldTest(arg)).length,
  where: (value, arg) => asList(value, 'where').filter(fieldTest(arg)),
  map: (value, arg) => asList(value, 'map').map(item => fieldOf(item, arg)),
  join: (value, arg) => asList(value, 'join').map(item => (isBlank(item) ? MISSING : String(item))).join(unescape(arg)),
  sort: (value, arg) =>
    [...asList(value, 'sort')].sort((a, b) => {
      const x = fieldOf(a, arg)
      const y = fieldOf(b, arg)
      const xMissing = x === undefined || x === null
      const yMissing = y === undefined || y === null
      if (xMissing || yMissing) return xMissing === yMissing ? 0 : xMissing ? 1 : -1
      if (typeof x === 'number' && typeof y === 'number') return x - y
      const xs = String(x)
      const ys = String(y)
      return xs < ys ? -1 : xs > ys ? 1 : 0
    }),
  take: (value, arg) => {
    if (!/^\d+$/.test(arg)) throw new Error('take: expected a whole number ≥ 0')
    return asList(value, 'take').slice(0, Number(arg))
  },
  split: (value, arg) => (isBlank(value) ? [] : String(value).split(unescape(arg))),
  trim: value => (isBlank(value) ? value : String(value).trim()),
  upper: value => (isBlank(value) ? value : String(value).toUpperCase()),
  default: (value, arg) => (isBlank(value) ? unescape(arg) : value),
}

/** Evaluates `path | filter | filter:arg`. */
export function evaluate(expression: string, scope: Scope): unknown {
  const [path = '', ...filters] = expression.split('|')
  let value = lookup(scope, path)
  for (const raw of filters) {
    const at = raw.indexOf(':')
    const name = (at < 0 ? raw : raw.slice(0, at)).trim()
    const arg = at < 0 ? '' : raw.slice(at + 1).trim()
    const filter = Object.hasOwn(FILTERS, name) ? FILTERS[name] : undefined
    if (filter === undefined) throw new Error(`unknown filter "${name}"`)
    value = filter(value, arg)
  }
  return value
}

const show = (value: unknown) =>
  value === undefined || value === null ? MISSING : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** A whole `{{…}}` keeps its value's type; text with expressions in it interpolates. */
export function fillString(text: string, scope: Scope): unknown {
  const whole = WHOLE.exec(text)
  if (whole !== null) return evaluate(whole[1] ?? '', scope)
  return text.replace(ANY, (_, expression: string) => show(evaluate(expression, scope)))
}

/** An expression reading the form: only a press knows its values. */
const FORM_EXPRESSION = /^\s*form\s*(?:[.[|]|$)/

/** Braces in data put into a prompt, held as private-use characters so the press reads no bindings in them. */
const OPEN_BRACE = '\uE000'
const CLOSE_BRACE = '\uE001'
const holdBraces = (text: string) => text.replace(/\{/g, OPEN_BRACE).replace(/\}/g, CLOSE_BRACE)

/** A prompt's text once the press filled it: the data's braces back as they were. */
export const restoreBraces = (text: string) => text.replace(/\uE000/g, '{').replace(/\uE001/g, '}')

/**
 * A template button's prompt: its data filled now (braces in it held, see
 * restoreBraces), its `{{form.…}}` kept for the press to fill.
 */
function fillPrompt(text: string, scope: Scope, at: string): string {
  try {
    return text.replace(ANY, (match, expression: string) =>
      FORM_EXPRESSION.test(expression) ? match : holdBraces(show(evaluate(expression, scope))),
    )
  } catch (error) {
    throw new Error(`${at}: ${(error as Error).message}`)
  }
}

const isTruthy = (value: unknown) =>
  !(value === undefined || value === null || value === false || value === 0 || value === '' || (Array.isArray(value) && value.length === 0))

const spread = (items: unknown[]) => ({ [SPREAD]: items })
const spreadOf = (value: unknown): unknown[] | undefined =>
  typeof value === 'object' && value !== null && SPREAD in value ? ((value as Record<string, unknown[]>)[SPREAD] ?? []) : undefined

const asText = (value: unknown) => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : value)

type Budget = { used: number }

function fill(node: unknown, scope: Scope, at: string, budget: Budget): unknown {
  if (typeof node === 'string') {
    try {
      return fillString(node, scope)
    } catch (error) {
      throw new Error(`${at}: ${(error as Error).message}`)
    }
  }
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => {
      const filled = fill(child, scope, `${at}[${i}]`, budget)
      const items = spreadOf(filled)
      if (items === undefined && typeof child === 'string' && (filled === undefined || filled === null)) return [MISSING]
      return (items ?? [filled]).filter(item => item !== undefined && item !== null).map(asText)
    })
  }
  if (typeof node !== 'object' || node === null) return node
  const record = node as Record<string, unknown>
  if (record.type === 'each') {
    if (typeof record.as !== 'string') throw new Error(`${at}.as: required string`)
    if (record.as === 'form') throw new Error(`${at}.as: "form" is reserved`)
    const items = fill(record.items, scope, `${at}.items`, budget)
    const list = Array.isArray(items) ? items : []
    const shown = list.slice(0, EACH_LIMIT)
    budget.used += shown.length
    if (budget.used > TOTAL_LIMIT) throw new Error(`tree: more than ${TOTAL_LIMIT} repeated nodes`)
    const drawn = shown
      .map((item, i) => fill(record.node, { ...scope, [record.as as string]: item }, `${at}.node[${i}]`, budget))
      .flatMap(d => spreadOf(d) ?? [d])
      .filter(d => d !== undefined && d !== null)
    const isNodeList = typeof record.node === 'object' && record.node !== null && !Array.isArray(record.node)
    if (list.length > EACH_LIMIT && isNodeList) drawn.push({ type: 'text', text: `+${list.length - EACH_LIMIT} more`, dim: true })
    return spread(drawn)
  }
  if (record.type === 'when') {
    const isMet = isTruthy(fill(record.test, scope, `${at}.test`, budget))
    const branch = isMet ? record.node : record.else
    return branch === undefined ? spread([]) : fill(branch, scope, `${at}.${isMet ? 'node' : 'else'}`, budget)
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const filled =
      record.type === 'button' && key === 'prompt' && typeof value === 'string'
        ? fillPrompt(value, scope, `${at}.${key}`)
        : fill(value, scope, `${at}.${key}`, budget)
    if (spreadOf(filled) !== undefined) throw new Error(`${at}.${key}: each/when must be inside a list`)
    if (filled === undefined || filled === null) continue
    const keepsType = TYPED_KEYS.has(key) || (key === 'value' && record.type === 'progress')
    out[key] = keepsType ? filled : asText(filled)
  }
  return out
}

/** Fills a template tree; a root `each` or `when` that spreads becomes a box. */
export function fillRoot(tree: unknown, scope: Scope): unknown {
  const filled = fill(tree, scope, 'tree', { used: 0 })
  const items = spreadOf(filled)
  return items === undefined ? filled : { type: 'box', children: items }
}
