import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GenuiButton, GenuiForm, GenuiLatest, GenuiView } from '../types'
import { fillString, restoreBraces } from './bind'
import { renderTemplate, renderView } from './render'
import { RESERVED_NAMES, initTemplate, listTemplates, locate, openTemplate, previewTemplate, reloadTemplate, runManualSource, tickTemplate } from './runner'
import {
  INPUT_SCHEMA,
  PREVIEW_DESCRIPTION,
  PREVIEW_SCHEMA,
  TOOL_DESCRIPTION,
  countdownEnd,
  initialValues,
  isInteractive,
  liveNodes,
  validate,
} from './schema'
import { templateView } from './template-file'

const TOOL = 'mcp__genui__render'
const PREVIEW = 'mcp__genui__preview_template'
const PANE = 'genui'
const FORMS = { plugin: 'genui', key: 'forms' } as const
const RUNS = { plugin: 'genui', key: 'runs' } as const
const latest = atom({ plugin: 'genui', key: 'latest' } as const, null)
const fired = atom({ plugin: 'genui', key: 'fired' } as const, [])

/** The view a call's input describes, or undefined when it does not validate. */
const viewOf = (id: string, input: Record<string, unknown>): GenuiView | undefined => {
  if (validate(input.tree).length > 0) return undefined
  return {
    id,
    title: typeof input.title === 'string' && input.title !== '' ? input.title : 'Generated UI',
    tree: input.tree as GenuiView['tree'],
    awaitResponse: input.awaitResponse === true,
    placement: input.placement === 'inline' ? 'inline' : 'pane',
  }
}

/** A drawing stored before `kind` existed has none: it is a drawn view. */
const drawnOf = (shown: GenuiLatest | null): GenuiView | undefined =>
  shown === null || shown.kind === 'template' ? undefined : shown

const formOf = async ($: EngineInterface, view: GenuiView): Promise<GenuiForm> =>
  (await read($, { ...FORMS, id: view.id })) ?? { status: 'open', values: initialValues(view.tree) }

/** Whether the side pane is on screen showing this view. */
const isInPane = async ($: EngineInterface, view: GenuiView) => {
  if (view.placement !== 'pane') return false
  if (drawnOf(await read($, latest))?.id !== view.id) return false
  const panes = await $.ui.panes().catch(() => [])

  return panes.some(pane => pane.id === PANE && pane.isPlaced)
}

/** `<`, `>` and `&` as entities: text inside a tag cannot close it or open another. */
const escapeTag = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What the model reads as the person's answer to a form; its values' `<`, `>` and `&` as JSON escapes. */
export const responseText = (view: GenuiView, form: GenuiForm, action: string) => {
  const attribute = (value: string) => escapeTag(JSON.stringify(value))
  const values = JSON.stringify(form.values).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  return `<genui-response id=${attribute(view.id)} title=${attribute(view.title)} action=${attribute(action)}>${values}</genui-response>`
}

/** A template's prompt as Claude reads it: marked as the template's, not the person's own words. */
export const templatePromptText = (template: string, origin: string, text: string) =>
  `<genui-prompt template=${escapeTag(JSON.stringify(template))} origin=${escapeTag(JSON.stringify(origin))}>\n${text.replace(/<\/genui-prompt/gi, '<\\/genui-prompt')}\n</genui-prompt>`

/** A `prompt` button's text, its bindings filled; the raw text where a binding fails. Data braces come back last. */
export const promptText = (button: GenuiButton, scope: Record<string, unknown>) => {
  const text = button.prompt ?? button.label
  try {
    const filled = fillString(text, scope)
    const shown = filled === undefined || filled === null ? '' : typeof filled === 'object' ? JSON.stringify(filled) : String(filled)
    return restoreBraces(shown)
  } catch {
    return restoreBraces(text)
  }
}

/** The closures a drawn view's fields and buttons call; `template` names the template a view is a run of. */
const handlersFor = ($: EngineInterface, view: GenuiView, template?: string) => ({
  onValue: (id: string, value: string) =>
    void update($, { ...FORMS, id: view.id }, form => {
      const current = form ?? { status: 'open' as const, values: initialValues(view.tree) }
      if (current.status !== 'open') return current
      return { ...current, values: { ...current.values, [id]: value } }
    }).catch(() => undefined),
  onButton: async (button: GenuiButton) => {
    const action = button.action ?? 'action'
    if (action === 'refresh' && template !== undefined) return void (await reloadTemplate($, template))
    if (action === 'run' && template !== undefined && button.source !== undefined) return runManualSource($, template, button.source)
    if (action === 'prompt') {
      const form = await formOf($, view)
      const run = template === undefined ? undefined : await read($, { ...RUNS, id: template })
      const text = promptText(button, { ...run?.data, now: run?.updatedAt, form: { ...initialValues(view.tree), ...form.values } })
      await $.prompt.submit({ text: template === undefined ? text : templatePromptText(template, run?.origin ?? 'unknown', text) })
      return
    }
    let closed: GenuiForm | undefined
    await update($, { ...FORMS, id: view.id }, form => {
      const current = form ?? { status: 'open' as const, values: initialValues(view.tree) }
      if (current.status !== 'open') return current
      closed = {
        ...current,
        status: action === 'cancel' ? 'cancelled' : 'submitted',
        pressed: button.id,
        values: action === 'cancel' ? {} : { ...initialValues(view.tree), ...current.values },
      }
      return closed
    })
    if (closed === undefined) return
    await $.prompt.submit({ text: responseText(view, closed, action === 'action' ? button.id : action) })
  },
})

/**
 * One second of the pane: a template refreshes on its period; a drawing
 * redraws while a live node moves and announces each countdown once.
 */
async function tick($: EngineInterface) {
  const shown = await read($, latest)
  if (shown === null) return
  if (shown.kind === 'template') return tickTemplate($, shown.name)
  const view = drawnOf(shown)
  if (view === undefined) return
  const live = liveNodes(view.tree)
  if (live.length === 0) return
  const { startedAt } = await formOf($, view)
  if (startedAt === undefined) return
  const now = await $.clock.now()
  let isMoving = false
  for (const node of live) {
    if (node.type !== 'countdown' || countdownEnd(node, startedAt) > now) {
      isMoving = true
      continue
    }
    const name = `${view.id}/${node.id}`
    if ((await read($, fired)).includes(name)) continue
    await update($, fired, list => [...list, name].slice(-100))
    const label = node.label ?? view.title
    const text = `${/^\p{Extended_Pictographic}/u.test(label) ? '' : '⏰ '}${label}: ${node.doneText ?? "time's up"}`
    $.ui.toast(text, { timeoutMs: 10_000 })
    void $.ui.notify(text, { title: view.title }).catch(() => undefined)
    isMoving = true
  }
  if (isMoving) $.ui.invalidate('ui.render')
}

/** `/genui` and its subcommands. */
async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [sub = '', name = ''] = args.trim().split(/\s+/)
  if (sub === '') {
    const shown = await read($, latest)
    if (shown === null) return 'No generated UI yet. Templates: /genui list'
    const title = shown.kind === 'template' ? ((await read($, { ...RUNS, id: shown.name }))?.template.title ?? shown.name) : shown.title
    const opened = await $.ui.open({ id: PANE, title }).catch(() => undefined)
    if (opened === undefined) return `Could not open the GenUI pane for "${title}".`
    return `Opened "${title}" in the GenUI pane.`
  }
  if (sub === 'list') {
    const templates = await listTemplates($)
    return ['Templates (open one with /genui <name>):', ...templates.map(t => `  ${t.name}  ${t.title}  (${t.origin})`)].join('\n')
  }
  if (sub === 'init') return name === '' ? 'Usage: /genui init <built-in name>' : initTemplate($, name)
  if (sub === 'refresh') {
    const shown = await read($, latest)
    if (shown?.kind !== 'template') return 'The pane shows no template.'
    return reloadTemplate($, shown.name)
  }
  if (sub === 'open' && name === '') return 'Usage: /genui open <name>'
  const wanted = sub === 'open' ? name : sub
  const located = await locate($, wanted)
  if (located === undefined) {
    const names = (await listTemplates($)).map(t => t.name).join(', ')
    return `No template "${wanted}". Templates: ${names}. (${RESERVED_NAMES.join(', ')} are subcommands, not template names.)`
  }
  return (await openTemplate($, located)).text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'render', description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'preview_template', description: PREVIEW_DESCRIPTION, inputSchema: PREVIEW_SCHEMA })
    await $.command.register({
      name: 'genui',
      description: 'Open the GenUI pane, or a template: /genui [name | open <name> | list | init <name> | refresh]',
      argumentHint: '[name | open <name> | list | init <name> | refresh]',
    })
    $.clock.every(1000, () => void tick($).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'genui' }, async ($, e) => ({ text: await runCommand($, e.args) })).catch(($, e, next) => ({
    text: `genui: the command failed: ${next.error.message ?? next.error.kind}`,
  }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const problems = validate(e.tree)
    if (problems.length > 0) {
      return { deny: `The UI tree does not validate; fix these and call again:\n${problems.map(p => `- ${p}`).join('\n')}` }
    }
    const view = viewOf(e.tool_use_id, e)
    if (view === undefined) return { deny: 'The UI tree does not validate.' }
    const startedAt = await $.clock.now()
    await update($, { ...FORMS, id: view.id }, form => ({
      ...(form ?? { status: 'open' as const, values: initialValues(view.tree) }),
      startedAt,
    }))
    await update($, latest, () => ({ kind: 'drawn' as const, ...view }))

    let where = 'inline in the transcript'
    const panes = await $.ui.panes().catch(() => [])
    if (view.placement === 'pane' || panes.some(pane => pane.id === PANE)) {
      const opened = await $.ui.open({ id: PANE, title: view.title }).catch(() => ({ isPlaced: false }))
      if (view.placement === 'pane') {
        where = opened.isPlaced ? 'in the side pane' : 'inline in the transcript (the side pane did not fit; the user can open it with /genui)'
      }
    }

    if (view.awaitResponse && isInteractive(view.tree)) {
      return {
        result: `Form "${view.title}" (id ${view.id}) is shown to the user ${where}. End your turn now: their answers arrive as their next message in a <genui-response id="${view.id}"> block.`,
      }
    }

    return { result: `UI "${view.title}" is shown to the user ${where}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'genui could not draw this UI; answer in text instead.' }))

  on('tool.call', { tool: PREVIEW }, async ($, e) => ({ result: await previewTemplate($, e) })).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'genui could not preview this template.' },
  )

  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    const input = e.props.input
    if (typeof input !== 'object' || input === null || e.props.isErrored || e.props.isInterrupted) return next(e)
    const view = viewOf(e.props.tool_use_id, input as Record<string, unknown>)
    if (view === undefined) return next(e)
    const table = $.ui.resolve(e)
    if (await isInPane($, view)) {
      const { Text } = table
      return (
        <Text>
          <Text bold color="claude">
            ◆ {view.title}
          </Text>
          <Text dimColor> · shown in the side pane</Text>
        </Text>
      )
    }

    return renderView(e.surface, table, view, await formOf($, view), handlersFor($, view), await $.clock.now())
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Text } = table
    const shown = await read($, latest)
    const now = await $.clock.now()
    if (shown === null) return <Text dimColor>No generated UI yet. Try /genui list.</Text>
    if (shown.kind === 'template') {
      const name = shown.name
      const run = await read($, { ...RUNS, id: name })
      if (run === undefined) return <Text dimColor>Loading {name}…</Text>
      const { view, problems } = templateView(run)
      return renderTemplate(e.surface, table, {
        run,
        problems,
        now,
        onRetry: () => void reloadTemplate($, name).catch(() => undefined),
        ...(view === undefined ? {} : { view, form: await formOf($, view), handlers: handlersFor($, view, name) }),
      })
    }
    const view = drawnOf(shown)
    if (view === undefined) return <Text dimColor>No generated UI yet.</Text>

    return renderView(e.surface, table, view, await formOf($, view), handlersFor($, view), now)
  })
}
