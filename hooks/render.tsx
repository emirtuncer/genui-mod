import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { GenuiForm, GenuiNode, GenuiTemplateRun, GenuiView } from '../types'
import { countdownEnd } from './schema'

export type Handlers = {
  onValue: (id: string, value: string) => void
  onButton: (node: Extract<GenuiNode, { type: 'button' }>) => void | Promise<void>
}

const BAR = 20

const progressBar = (value: number, max: number) => {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const full = Math.round(share * BAR)
  return `${'█'.repeat(full)}${'░'.repeat(BAR - full)} ${Math.round(share * 100)}%`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `m:ss`, or `h:mm:ss` past an hour. */
export const duration = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export const timeOfDay = (at: number) => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const markdownTable = (columns: string[], rows: string[][]) => {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const line = (cells: string[]) => `| ${columns.map((_, i) => cell(cells[i] ?? '')).join(' | ')} |`
  return [line(columns), `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
}

export type ViewOptions = {
  /** A template's view: its refresh, run and prompt buttons stay live once the form closes. */
  liveActions?: boolean
}

/** What a template's buttons do beside answering the form: never locked by its closing. */
const LIVE_ACTIONS = new Set(['refresh', 'run', 'prompt'])

const STATUS_LINE: Record<GenuiForm['status'], string> = {
  open: '',
  submitted: '✓ Submitted',
  cancelled: '✗ Cancelled',
}

/**
 * Draws a view with the surface's own elements. Fields are live while the
 * form is open and show their answers once it closes; a surface with no
 * fields (mobile) shows the field's value as text. With `liveActions` (a
 * template), refresh, run and prompt buttons stay live after it closes.
 */
export function renderView(surface: RenderSurface, table: ElementTable, view: GenuiView, form: GenuiForm, handlers: Handlers, now: number, options: ViewOptions = {}) {
  const startedAt = form.startedAt ?? now
  const { Box, Text, Button, Markdown, Code, Link } = table
  const isOpen = form.status === 'open'
  const hasFields = surface !== 'mobile' && 'Input' in table && 'Select' in table

  const field = (label: string | undefined, value: string) => (
    <Box flexDirection="row" gap={1}>
      {label !== undefined && <Text bold>{label}:</Text>}
      <Text dimColor={!isOpen}>{value === '' ? '—' : value}</Text>
    </Box>
  )

  const draw = (node: GenuiNode, path: string): RenderChildren => {
    switch (node.type) {
      case 'box':
        return (
          <Box
            key={path}
            flexDirection={node.direction ?? 'column'}
            gap={node.gap ?? (node.direction === 'row' ? 2 : 0)}
            padding={node.padding ?? (node.border ? 1 : 0)}
            paddingY={node.border ? 0 : undefined}
            borderStyle={node.border ? 'round' : undefined}
            borderDimColor={node.border ? true : undefined}
          >
            {node.title !== undefined && <Text bold>{node.title}</Text>}
            {(node.children ?? []).map((child, i) => draw(child, `${path}.${i}`))}
          </Box>
        )
      case 'text':
        return (
          <Text bold={node.bold} dimColor={node.dim} italic={node.italic} color={node.color}>
            {node.text}
          </Text>
        )
      case 'markdown':
        return <Markdown text={node.text} />
      case 'code':
        return <Code source={node.source} language={node.language} />
      case 'link':
        return <Link href={node.href}>{node.label ?? node.href}</Link>
      case 'divider':
        return <Text dimColor>{'─'.repeat(BAR + 5)}</Text>
      case 'table':
        return <Markdown text={markdownTable(node.columns, node.rows)} />
      case 'progress':
        return (
          <Box flexDirection="row" gap={1}>
            {node.label !== undefined && <Text>{node.label}</Text>}
            <Text color="success">{progressBar(node.value, node.max ?? 100)}</Text>
          </Box>
        )
      case 'kv':
        return (
          <Box flexDirection="column">
            {node.items.map(item => (
              <Box flexDirection="row" gap={1}>
                <Text bold>{item.key}</Text>
                <Text>{item.value}</Text>
              </Box>
            ))}
          </Box>
        )
      case 'input': {
        const value = form.values[node.id] ?? node.default ?? ''
        if (!isOpen || !hasFields) return field(node.label, value)
        const { Input } = table
        return (
          <Input
            key={`input:${node.id}`}
            label={node.label}
            placeholder={node.placeholder}
            value={value}
            onInput={text => handlers.onValue(node.id, text)}
            onSubmit={text => handlers.onValue(node.id, text)}
          />
        )
      }
      case 'select': {
        const value = form.values[node.id] ?? node.default ?? node.options[0]?.value ?? ''
        if (!isOpen || !hasFields) {
          const chosen = node.options.find(option => option.value === value)
          return field(node.label, chosen?.label ?? value)
        }
        const { Select } = table
        return (
          <Select
            key={`select:${node.id}`}
            label={node.label}
            options={node.options}
            value={value}
            onSelect={picked => handlers.onValue(node.id, picked)}
          />
        )
      }
      case 'countdown': {
        const end = countdownEnd(node, startedAt)
        const left = end - now
        const isDone = left <= 0
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {node.label !== undefined && <Text bold>{node.label}</Text>}
              <Text bold color={isDone ? 'success' : 'claude'}>
                {isDone ? `✓ ${node.doneText ?? "Time's up"}` : duration(left)}
              </Text>
            </Box>
            <Text color={isDone ? 'success' : undefined} dimColor={!isDone}>
              {progressBar(now - startedAt, Math.max(1, end - startedAt))}
            </Text>
            <Text dimColor>ends {timeOfDay(end)}</Text>
          </Box>
        )
      }
      case 'stopwatch':
        return (
          <Box flexDirection="row" gap={1}>
            {node.label !== undefined && <Text bold>{node.label}</Text>}
            <Text>{duration(now - startedAt)}</Text>
          </Box>
        )
      case 'clock':
        return (
          <Box flexDirection="row" gap={1}>
            {node.label !== undefined && <Text bold>{node.label}</Text>}
            <Text>{timeOfDay(now)}</Text>
          </Box>
        )
      case 'button':
        if (!isOpen && !(options.liveActions === true && LIVE_ACTIONS.has(node.action ?? 'action'))) return <Text dimColor={form.pressed !== node.id}>[ {node.label} ]</Text>
        return (
          <Button
            key={`button:${node.id}`}
            label={node.label}
            variant={node.variant ?? (node.action === 'submit' ? 'primary' : undefined)}
            onPress={() => handlers.onButton(node)}
          />
        )
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold color="claude">
        ◆ {view.title}
      </Text>
      {draw(view.tree, 'root')}
      {!isOpen && <Text dimColor>{STATUS_LINE[form.status]}</Text>}
    </Box>
  )
}

export type TemplateFrame = {
  run: GenuiTemplateRun
  view?: GenuiView
  form?: GenuiForm
  problems: string[]
  now: number
  handlers?: Handlers
  onRetry: () => void
}

/**
 * A template run in the pane: its filled view (or its title while there is
 * none), a status line, and a box of the problems that stand, with Retry.
 */
export function renderTemplate(surface: RenderSurface, table: ElementTable, frame: TemplateFrame) {
  const { Box, Text, Button } = table
  const { run, view, form, handlers, now } = frame
  const problems = [...run.errors, ...frame.problems]
  const parts = [`${run.name} (${run.origin})`]
  if (run.isLoading) parts.push('loading…')
  else if (run.updatedAt !== undefined) parts.push(`updated ${timeOfDay(run.updatedAt)} · ${((run.durationMs ?? 0) / 1000).toFixed(1)}s`)
  if ((run.template.refreshSeconds ?? 0) > 0) parts.push(`every ${Math.max(5, run.template.refreshSeconds ?? 0)}s`)

  return (
    <Box flexDirection="column">
      {view !== undefined && form !== undefined && handlers !== undefined ? (
        renderView(surface, table, view, form, handlers, now, { liveActions: true })
      ) : (
        <Text bold color="claude">
          ◆ {run.template.title}
        </Text>
      )}
      <Text dimColor>{parts.join(' · ')}</Text>
      {problems.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
          {problems.map(problem => (
            <Text color="error">{problem}</Text>
          ))}
          <Button key="genui-retry" label="Retry" onPress={frame.onRetry} />
        </Box>
      )}
    </Box>
  )
}
