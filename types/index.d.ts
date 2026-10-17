export type GenuiJson = string | number | boolean | null | GenuiJson[] | { [key: string]: GenuiJson }

export type GenuiButtonAction = 'submit' | 'cancel' | 'action' | 'prompt' | 'refresh' | 'run'

export type GenuiNode =
  | { type: 'box'; direction?: 'row' | 'column'; gap?: number; padding?: number; border?: boolean; title?: string; children?: GenuiNode[] }
  | { type: 'text'; text: string; bold?: boolean; dim?: boolean; italic?: boolean; color?: string }
  | { type: 'markdown'; text: string }
  | { type: 'code'; source: string; language?: string }
  | { type: 'link'; href: string; label?: string }
  | { type: 'divider' }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'progress'; value: number; max?: number; label?: string }
  | { type: 'kv'; items: { key: string; value: string }[] }
  | { type: 'input'; id: string; label?: string; placeholder?: string; default?: string }
  | { type: 'select'; id: string; label?: string; options: { value: string; label?: string }[]; default?: string }
  | { type: 'button'; id: string; label: string; variant?: 'primary' | 'secondary'; action?: GenuiButtonAction; prompt?: string; source?: string }
  | { type: 'countdown'; id: string; seconds?: number; until?: string; label?: string; doneText?: string }
  | { type: 'stopwatch'; label?: string }
  | { type: 'clock'; label?: string }

export type GenuiButton = Extract<GenuiNode, { type: 'button' }>

export type GenuiView = {
  id: string
  title: string
  tree: GenuiNode
  awaitResponse: boolean
  placement: 'pane' | 'inline'
}

/** What the pane shows: Claude's latest drawing, or a template by name. */
export type GenuiLatest = ({ kind: 'drawn' } & GenuiView) | { kind: 'template'; name: string }

export type GenuiForm = {
  status: 'open' | 'submitted' | 'cancelled'
  values: Record<string, string>
  pressed?: string
  /** When the call drew the view, epoch ms: what live nodes count from. */
  startedAt?: number
}

export type GenuiTemplateSource = {
  argv: string[]
  parse: 'json' | 'text' | 'lines'
  timeoutMs?: number
  cwd?: string
  /** A non-zero exit still counts as data (test runners exit 1 on a failure). */
  allowFailure?: boolean
  /** Run only by a `run` button, never on refresh. */
  manual?: boolean
}

export type GenuiTemplate = {
  title: string
  description?: string
  sources: Record<string, GenuiTemplateSource>
  refreshSeconds?: number
  tree: { [key: string]: GenuiJson }
}

export type GenuiTemplateOrigin = 'project' | 'user' | 'builtin' | 'preview'

export type GenuiTemplateRun = {
  name: string
  origin: GenuiTemplateOrigin
  /** The session root the run was approved under; its sources run there. */
  root: string
  path?: string
  template: GenuiTemplate
  data?: { [source: string]: GenuiJson }
  errors: string[]
  isLoading: boolean
  loadingSince?: number
  updatedAt?: number
  durationMs?: number
}

declare module 'claude-code' {
  interface PluginState {
    genui: {
      forms: StateFamily<GenuiForm>
      latest: GenuiLatest | null
      /** Countdowns whose end was announced, as `<view id>/<node id>`. */
      fired: string[]
      /** Each template's last run, by template name. */
      runs: StateFamily<GenuiTemplateRun>
    }
  }
}
