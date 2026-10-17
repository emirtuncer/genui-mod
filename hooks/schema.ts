import type { GenuiNode } from '../types'

export const MAX_DEPTH = 12
export const MAX_NODES = 300

const NODE_DOC = `Each node is a JSON object with a "type":
- box: { direction?: "row"|"column", gap?, padding?, border?: boolean, title?, children?: Node[] }
- text: { text, bold?, dim?, italic?, color? (a color name or #hex) }
- markdown: { text }  (headings, lists, tables, code fences, links)
- code: { source, language? }
- link: { href, label? }
- divider: {}
- table: { columns: string[], rows: string[][] }
- progress: { value, max? (default 100), label? }
- kv: { items: [{ key, value }] }
- input: { id, label?, placeholder?, default? }  (a text field)
- select: { id, label?, options: [{ value, label? }], default? }  (pick one)
- button: { id, label, variant?: "primary"|"secondary", action?: "submit"|"cancel"|"action"|"prompt", prompt? }  ("prompt" sends its prompt text to Claude as the user's message without closing the form; {{form.<id>}} in it is that field's value)
Live nodes, which the mod itself redraws every second (no script needed):
- countdown: { id, seconds? | until? (ISO time), label?, doneText? }  (remaining time and a bar; a toast and a notification when it ends)
- stopwatch: { label? }  (time since the UI was drawn)
- clock: { label? }  (the current local time)
Ids of input, select, button and countdown must be unique within the tree.`

export const TOOL_DESCRIPTION = `Draw a generative UI for the user, in the side pane (or inline in the transcript with placement "inline"): cards, layouts, tables, progress, markdown, code, and forms.

Use it when a visual layout or a form communicates better than prose: summaries, dashboards, comparisons, choices with several fields, gathering structured input, or live things like timers.

Placement: "pane" (the default) draws it in the side pane, with a one-line pointer in the transcript; "inline" draws it in the transcript. Use "pane" for anything live or long-lived (timers, dashboards), "inline" for one-off answers.

${NODE_DOC}

Forms: set "awaitResponse": true when the UI holds inputs, selects or buttons whose answers you need. After calling the tool with awaitResponse, END YOUR TURN immediately without further text or tool calls: the user's answers arrive as their next message, as <genui-response id="..." action="submit|cancel|<button id>">{json of field values}</genui-response>. Buttons with action "submit" or "cancel" (or "action", which sends the button's id) close the form.`

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short title shown above the UI.' },
    tree: { type: 'object', description: 'The root node of the UI. ' + NODE_DOC },
    placement: {
      type: 'string',
      enum: ['pane', 'inline'],
      description: 'Where to draw it: "pane" (default, the side pane) or "inline" (the transcript).',
    },
    awaitResponse: {
      type: 'boolean',
      description: 'True when the UI is a form whose answers you need; end your turn after the call.',
    },
  },
  required: ['title', 'tree'],
} as const

type Problems = string[]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const optional = (node: Record<string, unknown>, key: string, check: (v: unknown) => boolean, kind: string, at: string, problems: Problems) => {
  if (node[key] !== undefined && !check(node[key])) problems.push(`${at}.${key}: expected ${kind}`)
}

const required = (node: Record<string, unknown>, key: string, check: (v: unknown) => boolean, kind: string, at: string, problems: Problems) => {
  if (!check(node[key])) problems.push(`${at}.${key}: required ${kind}`)
}

const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const isBoolean = (v: unknown) => typeof v === 'boolean'
const isStringArray = (v: unknown) => Array.isArray(v) && v.every(isString)

/**
 * Checks a tree the model sent and answers the problems, each led by the
 * path of the node it is about, so the model can fix the call; empty when
 * the tree is good.
 */
export type ValidateOptions = { isTemplate?: boolean }

export function validate(tree: unknown, options: ValidateOptions = {}): Problems {
  const problems: Problems = []
  const ids = new Set<string>()
  let count = 0

  const visit = (node: unknown, at: string, depth: number) => {
    count += 1
    if (count > MAX_NODES) {
      if (count === MAX_NODES + 1) problems.push(`tree: more than ${MAX_NODES} nodes`)
      return
    }
    if (depth > MAX_DEPTH) {
      problems.push(`${at}: nested deeper than ${MAX_DEPTH}`)
      return
    }
    if (!isObject(node)) {
      problems.push(`${at}: expected a node object`)
      return
    }
    const claimId = () => {
      if (!isString(node.id) || node.id.length === 0) return problems.push(`${at}.id: required non-empty string`)
      if (ids.has(node.id)) problems.push(`${at}.id: "${node.id}" is used twice`)
      ids.add(node.id)
    }
    switch (node.type) {
      case 'box':
        optional(node, 'direction', v => v === 'row' || v === 'column', '"row" or "column"', at, problems)
        optional(node, 'gap', isNumber, 'a number', at, problems)
        optional(node, 'padding', isNumber, 'a number', at, problems)
        optional(node, 'border', isBoolean, 'a boolean', at, problems)
        optional(node, 'title', isString, 'a string', at, problems)
        if (node.children !== undefined) {
          if (!Array.isArray(node.children)) problems.push(`${at}.children: expected an array`)
          else node.children.forEach((child, i) => visit(child, `${at}.children[${i}]`, depth + 1))
        }
        return
      case 'text':
        required(node, 'text', isString, 'string', at, problems)
        for (const flag of ['bold', 'dim', 'italic']) optional(node, flag, isBoolean, 'a boolean', at, problems)
        optional(node, 'color', isString, 'a string', at, problems)
        return
      case 'markdown':
        required(node, 'text', isString, 'string', at, problems)
        return
      case 'code':
        required(node, 'source', isString, 'string', at, problems)
        optional(node, 'language', isString, 'a string', at, problems)
        return
      case 'link':
        required(node, 'href', v => isString(v) && /^(https?|file):/.test(v), 'http(s) or file URL', at, problems)
        optional(node, 'label', isString, 'a string', at, problems)
        return
      case 'divider':
        return
      case 'table':
        required(node, 'columns', isStringArray, 'array of strings', at, problems)
        required(node, 'rows', v => Array.isArray(v) && v.every(isStringArray), 'array of string arrays', at, problems)
        return
      case 'progress':
        required(node, 'value', isNumber, 'number', at, problems)
        optional(node, 'max', v => isNumber(v) && (v as number) >= 0, 'a number ≥ 0', at, problems)
        optional(node, 'label', isString, 'a string', at, problems)
        return
      case 'kv':
        required(node, 'items', v => Array.isArray(v) && v.every(item => isObject(item) && isString(item.key) && isString(item.value)), 'array of { key, value } strings', at, problems)
        return
      case 'input':
        claimId()
        for (const key of ['label', 'placeholder', 'default']) optional(node, key, isString, 'a string', at, problems)
        return
      case 'select':
        claimId()
        optional(node, 'label', isString, 'a string', at, problems)
        optional(node, 'default', isString, 'a string', at, problems)
        required(node, 'options', v => Array.isArray(v) && v.length > 0 && v.every(o => isObject(o) && isString(o.value) && (o.label === undefined || isString(o.label))), 'non-empty array of { value, label? }', at, problems)
        return
      case 'button':
        claimId()
        required(node, 'label', isString, 'string', at, problems)
        optional(node, 'variant', v => v === 'primary' || v === 'secondary', '"primary" or "secondary"', at, problems)
        const actions = options.isTemplate
          ? ['submit', 'cancel', 'action', 'prompt', 'refresh', 'run']
          : ['submit', 'cancel', 'action', 'prompt']
        optional(node, 'action', v => actions.includes(v as string), actions.map(a => `"${a}"`).join(', '), at, problems)
        optional(node, 'prompt', isString, 'a string', at, problems)
        optional(node, 'source', isString, 'a string', at, problems)
        if (node.action === 'prompt' && !isString(node.prompt)) problems.push(`${at}.prompt: required string for action "prompt"`)
        if (node.action === 'run' && !isString(node.source)) problems.push(`${at}.source: required string for action "run"`)
        return
      case 'countdown':
        if (options.isTemplate) return void problems.push(`${at}: live nodes are not supported in templates`)
        claimId()
        if (node.seconds === undefined && node.until === undefined) problems.push(`${at}: give seconds or until`)
        optional(node, 'seconds', v => isNumber(v) && (v as number) > 0, 'a positive number', at, problems)
        optional(node, 'until', v => isString(v) && !Number.isNaN(Date.parse(v)), 'an ISO date-time', at, problems)
        optional(node, 'label', isString, 'a string', at, problems)
        optional(node, 'doneText', isString, 'a string', at, problems)
        return
      case 'stopwatch':
      case 'clock':
        if (options.isTemplate) return void problems.push(`${at}: live nodes are not supported in templates`)
        optional(node, 'label', isString, 'a string', at, problems)
        return
      default:
        problems.push(`${at}.type: unknown type ${JSON.stringify(node.type)}`)
    }
  }

  visit(tree, 'tree', 0)
  return problems
}

/** The starting values of a tree's fields: each input's and select's default. */
export function initialValues(tree: GenuiNode): Record<string, string> {
  const values: Record<string, string> = {}
  const visit = (node: GenuiNode) => {
    if (node.type === 'input' && node.default !== undefined) values[node.id] = node.default
    if (node.type === 'select') values[node.id] = node.default ?? node.options[0]?.value ?? ''
    if (node.type === 'box') node.children?.forEach(visit)
  }
  visit(tree)
  return values
}

/** Whether the tree holds anything the person can answer. */
export function isInteractive(tree: GenuiNode): boolean {
  if (tree.type === 'input' || tree.type === 'select' || tree.type === 'button') return true
  return tree.type === 'box' && (tree.children ?? []).some(isInteractive)
}

type Live = Extract<GenuiNode, { type: 'countdown' | 'stopwatch' | 'clock' }>

/** The tree's live nodes, the ones redrawn every second. */
export function liveNodes(tree: GenuiNode): Live[] {
  if (tree.type === 'countdown' || tree.type === 'stopwatch' || tree.type === 'clock') return [tree]
  return tree.type === 'box' ? (tree.children ?? []).flatMap(liveNodes) : []
}

/** When a countdown ends, epoch ms, counted from when its view was drawn. */
export function countdownEnd(node: Extract<GenuiNode, { type: 'countdown' }>, startedAt: number): number {
  return node.until !== undefined ? Date.parse(node.until) : startedAt + (node.seconds ?? 0) * 1000
}

export const TEMPLATE_DOC = `A GenUI template is a JSON file: .claude/genui/<name>.json in the project, or ~/.claude/genui/<name>.json for the user. The user opens it with /genui <name>.
{
  "title": "…", "description"?: "…",
  "sources": { "<name>": { "argv": ["cmd", "arg"], "parse": "json"|"text"|"lines", "timeoutMs"?, "cwd"?, "allowFailure"?: true, "manual"?: true } },
  "refreshSeconds"?: 10,
  "tree": <node>
}
Commands run without a shell. Their output is data under the source's name. In any string of the tree, {{path | filter:arg}} binds it: a string that is one whole {{…}} keeps the value's type (numbers for progress), others interpolate.
Paths: r.items[0].name. Filters: length, first, last, count:k=v, where:k=v, where:k!=v, map:k, join:x, sort:k, take:n, split:x, trim, upper, default:x (\t \n \s escapes).
Extra nodes: { "type": "each", "items": "{{…}}", "as": "x", "node": <node, or a table row array> }, { "type": "when", "test": "{{…}}", "node": <node>, "else"?: <node> }.
Extra button actions in templates: "refresh" (run every source again), "run" with "source" (run a "manual" source, then refresh). "prompt" may use {{source.path}} and {{form.<id>}}.`

export const PREVIEW_DESCRIPTION = `Run a GenUI template and show it in the side pane, answering the problems found (validation, command errors, binding errors) or a short summary. Use it while writing a template file to check it.

${TEMPLATE_DOC}`

export const PREVIEW_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A saved template to run (project, user or built-in).' },
    template: { type: 'object', description: 'A template object to run without saving it.' },
  },
} as const
