import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { GenuiJson, GenuiTemplate, GenuiTemplateOrigin, GenuiTemplateRun, GenuiTemplateSource } from '../types'
import { BUILTINS } from './builtins'
import { DEFAULT_TIMEOUT_MS, NAME, fingerprint, maxTimeout, parseOutput, resolveCwd, templateView, validateTemplate } from './template-file'

const RUNS = { plugin: 'genui', key: 'runs' } as const
const FORMS = { plugin: 'genui', key: 'forms' } as const
const latest = atom({ plugin: 'genui', key: 'latest' } as const, null)
const PANE = 'genui'
const MIN_REFRESH_SECONDS = 5
const STDERR_LINES = 20
/** A failure this soon after the start is a program that did not start. */
const START_FAILURE_MS = 2_000
/** Characters cmd.exe reads as syntax: an argument holding one is never retried through it. */
const SHELL_CHARS = /[&|<>^%!"()\r\n]/
const TIMEOUT_MESSAGE = /timed? ?out|still running/i
/** Names `/genui` reads as subcommands: no template can take them. */
export const RESERVED_NAMES: readonly string[] = ['list', 'init', 'refresh', 'open']

export type Located = { name: string; origin: GenuiTemplateOrigin; path?: string; raw?: unknown; problem?: string }

const slash = (path: string) => path.replace(/\\/g, '/')

const isTemplateName = (name: string) => NAME.test(name) && !RESERVED_NAMES.includes(name)

async function sessionRoot($: EngineInterface) {
  return slash(await $.session.root())
}

async function templateDirs($: EngineInterface): Promise<[GenuiTemplateOrigin, string][]> {
  const home = slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  const dirs: [GenuiTemplateOrigin, string][] = [['project', `${await sessionRoot($)}/.claude/genui`]]
  if (home !== '') dirs.push(['user', `${home}/.claude/genui`])
  return dirs
}

/** Finds a template: the project's, then the user's, then a built-in one. */
export async function locate($: EngineInterface, name: string): Promise<Located | undefined> {
  if (!isTemplateName(name)) return undefined
  for (const [origin, dir] of await templateDirs($)) {
    const path = `${dir}/${name}.json`
    if (!(await $.fs.exists(path).catch(() => false))) continue
    try {
      return { name, origin, path, raw: JSON.parse(await $.fs.read(path)) }
    } catch (error) {
      return { name, origin, path, problem: `${path}: ${(error as Error).message}` }
    }
  }
  return Object.hasOwn(BUILTINS, name) ? { name, origin: 'builtin', raw: BUILTINS[name] } : undefined
}

/** Every template a name reaches, the one that wins for each name. */
export async function listTemplates($: EngineInterface): Promise<{ name: string; origin: GenuiTemplateOrigin; title: string }[]> {
  const found = new Map<string, { name: string; origin: GenuiTemplateOrigin; title: string }>()
  for (const [origin, dir] of await templateDirs($)) {
    if (!(await $.fs.exists(dir).catch(() => false))) continue
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const name = entry.name.slice(0, -'.json'.length)
      if (!isTemplateName(name) || found.has(name)) continue
      let title = '(unreadable)'
      try {
        const raw: unknown = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
        if (typeof raw === 'object' && raw !== null && typeof (raw as { title?: unknown }).title === 'string') title = (raw as { title: string }).title
      } catch {
        // listed as unreadable; opening it says why
      }
      found.set(name, { name, origin, title })
    }
  }
  for (const [name, template] of Object.entries(BUILTINS)) {
    if (!found.has(name)) found.set(name, { name, origin: 'builtin', title: template.title })
  }
  return [...found.values()]
}

/** How much of each prompt the approval dialog shows. */
const PROMPT_SHOWN = 300

/** Every button `prompt` string anywhere in a template's raw tree, each once, in order. */
export function promptsOf(tree: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'prompt' && typeof value === 'string') {
        if (!found.includes(value)) found.push(value)
      } else walk(value)
    }
  }
  walk(tree)
  return found
}

export type OpenOptions = {
  /** Claude started it (preview_template): ask whatever the origin. */
  requireApproval?: boolean
  /** A reload of the run already shown (Retry, refresh): the pane is not opened again. */
  isReload?: boolean
}

/**
 * A template's commands and prompt texts run once the person approved exactly
 * them under this root: a project's or a preview's always, a user's or a
 * built-in's only when Claude started it.
 */
async function ensureApproved($: EngineInterface, root: string, located: Located, template: GenuiTemplate, options: OpenOptions): Promise<boolean> {
  if ((located.origin === 'user' || located.origin === 'builtin') && options.requireApproval !== true) return true
  const prompts = promptsOf(template.tree)
  const key = `approved:${root}|${located.name}|${await fingerprint({ sources: template.sources, prompts })}`
  if ((await $.store.get(key)) === true) return true
  const commands = Object.entries(template.sources)
    .map(([name, source]) => `  ${name}: ${JSON.stringify(source.argv)}${source.cwd === undefined ? '' : ` in ${resolveCwd(root, source.cwd)}`}`)
    .join('\n')
  const shownPrompts = prompts.map(prompt => (prompt.length > PROMPT_SHOWN ? `${prompt.slice(0, PROMPT_SHOWN)}…` : prompt))
  const promptLine = prompts.length === 0 ? '' : `\nIts buttons send Claude:\n  prompts: ${JSON.stringify(shownPrompts)}`
  let answer: string
  try {
    answer = await $.ui.ask(`Template "${located.name}" (${located.origin}) runs:\n${commands}${promptLine}\nRun these commands?`, {
      options: ['Run', 'Cancel'],
      header: 'genui',
    })
  } catch {
    return false
  }
  if (answer !== 'Run') return false
  await $.store.set(key, true)
  return true
}

/** The first lines of a command's stderr. */
const stderrHead = (stderr: string) => stderr.split(/\r?\n/).slice(0, STDERR_LINES).join('\n').trim()

/**
 * Runs argv. On Windows, a bare program (npx is npx.cmd) or a .cmd/.bat one
 * that fails to start is tried once more through cmd.exe, unless an argument
 * holds a shell character, the failure was a timeout, or it came late.
 */
async function runArgv($: EngineInterface, argv: readonly string[], init: ProcessRunInit) {
  const startedAt = await $.clock.now()
  try {
    return await $.process.run(argv, init)
  } catch (error) {
    const program = argv[0] ?? ''
    const message = error instanceof Error ? error.message : String(error)
    const isQuick = (await $.clock.now()) - startedAt < START_FAILURE_MS
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const isRetryable = !/[.\\/]/.test(program) || /\.(cmd|bat)$/i.test(program)
    if (!isQuick || timeoutMs <= START_FAILURE_MS || TIMEOUT_MESSAGE.test(message) || !isRetryable) throw error
    if ((await $.env.get('OS')) !== 'Windows_NT') throw error
    if (argv.some(arg => SHELL_CHARS.test(arg))) {
      throw new Error(`${message} (on Windows, ${program} may need cmd.exe; arguments with shell characters are not retried)`)
    }
    const shell = (await $.env.get('ComSpec')) ?? 'C:/Windows/System32/cmd.exe'
    let retried: ProcessRunResult
    try {
      retried = await $.process.run([shell, '/d', '/c', ...argv], init)
    } catch {
      throw error
    }
    if (retried.exitCode !== 0 && retried.stdout.trim() === '') {
      const stderr = stderrHead(retried.stderr)
      throw new Error(`${message}; through cmd.exe it exited ${retried.exitCode}${stderr === '' ? '' : `\n${stderr}`}`)
    }
    return retried
  }
}

async function runSource($: EngineInterface, root: string, name: string, source: GenuiTemplateSource): Promise<{ value?: GenuiJson; error?: string }> {
  try {
    const result = await runArgv($, source.argv, {
      cwd: resolveCwd(root, source.cwd),
      timeoutMs: source.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    const stderr = result.exitCode === 0 ? '' : stderrHead(result.stderr)
    if (result.exitCode !== 0 && source.allowFailure !== true) {
      return { error: `${name}: exited ${result.exitCode}${stderr === '' ? '' : `\n${stderr}`}` }
    }
    const parsed = parseOutput(name, result.stdout, source.parse)
    if (parsed.error === undefined || result.exitCode === 0) return parsed
    const why = parsed.error.startsWith(`${name}: `) ? parsed.error.slice(name.length + 2) : parsed.error
    return { error: `${name}: exited ${result.exitCode}, ${why}${stderr === '' ? '' : `\n${stderr}`}` }
  } catch (error) {
    return { error: `${name}: ${(error as Error).message}` }
  }
}

/** The root a run's sources run in; a run stored before `root` existed falls back to the session's. */
async function rootOf($: EngineInterface, run: GenuiTemplateRun): Promise<string> {
  return (run as Partial<GenuiTemplateRun>).root ?? (await sessionRoot($))
}

/** The run with no loading mark. */
const settled = ({ loadingSince: _, ...run }: GenuiTemplateRun): GenuiTemplateRun => ({ ...run, isLoading: false })

/** Whether a run is loading, and not for so long that the load must have died. */
const isBusy = (run: GenuiTemplateRun, now: number) => run.isLoading && now - (run.loadingSince ?? 0) < maxTimeout(run.template) + 10_000

/** Only the data of sources the template still has. */
const keptData = (data: GenuiTemplateRun['data'], template: GenuiTemplate): Record<string, GenuiJson> =>
  Object.fromEntries(Object.entries(data ?? {}).filter(([name]) => Object.hasOwn(template.sources, name)))

export type RefreshOptions = { resetForm?: boolean }

/**
 * Runs every source that is not manual and keeps the data; resets the
 * template's form when asked. Answers false when it did not run: no such
 * run, or a refresh of it still in flight.
 */
export async function refreshTemplate($: EngineInterface, name: string, options: RefreshOptions = {}): Promise<boolean> {
  const ref = { ...RUNS, id: name }
  const run = await read($, ref)
  if (run === undefined) return false
  const startedAt = await $.clock.now()
  if (isBusy(run, startedAt)) return false
  await update($, ref, current => ({ ...(current ?? run), isLoading: true, loadingSince: startedAt }))
  const root = await rootOf($, run)
  const sources = Object.entries(run.template.sources).filter(([, source]) => source.manual !== true)
  const outcomes = await Promise.all(sources.map(([sourceName, source]) => runSource($, root, sourceName, source)))
  const data: Record<string, GenuiJson> = {}
  const errors: string[] = []
  sources.forEach(([sourceName], i) => {
    const outcome = outcomes[i]
    if (outcome?.error !== undefined) errors.push(outcome.error)
    else data[sourceName] = outcome?.value ?? null
  })
  const doneAt = await $.clock.now()
  const hasData = Object.keys(data).length > 0
  await update($, ref, current => {
    const base = current ?? run
    // No data until a source has succeeded once: a first failure shows only its error.
    const kept = base.data === undefined && !hasData ? undefined : keptData({ ...base.data, ...data }, base.template)
    return {
      ...settled(base),
      errors,
      ...(kept === undefined ? {} : { data: kept }),
      updatedAt: doneAt,
      durationMs: doneAt - startedAt,
    }
  })
  if (options.resetForm === true) await $.state.set({ ...FORMS, id: `template:${name}` }, { status: 'open', values: {} })
  return true
}

/** A `run` button: runs one manual source, then refreshes the rest (the form kept). */
export async function runManualSource($: EngineInterface, name: string, sourceName: string): Promise<void> {
  const ref = { ...RUNS, id: name }
  const run = await read($, ref)
  if (run === undefined) return
  const source = Object.hasOwn(run.template.sources, sourceName) ? run.template.sources[sourceName] : undefined
  if (source === undefined) {
    await update($, ref, current => ({ ...(current ?? run), errors: [`run: no source named "${sourceName}"`] }))
    return
  }
  const startedAt = await $.clock.now()
  if (isBusy(run, startedAt)) {
    $.ui.toast(`genui: "${name}" is still running`)
    return
  }
  await update($, ref, current => ({ ...(current ?? run), isLoading: true, loadingSince: startedAt }))
  const outcome = await runSource($, await rootOf($, run), sourceName, source)
  const error = outcome.error
  await update($, ref, current => ({ ...settled(current ?? run), ...(error === undefined ? {} : { errors: [error] }) }))
  if (error !== undefined) return
  await refreshTemplate($, name, { resetForm: false })
}

export type Opened = {
  text: string
  problems: string[]
  /** Whether the run was stored and shown; false when the template was unreadable, invalid or declined. */
  isShown: boolean
  /** A refresh of it was still in flight, so this one did not run. */
  isStillRunning?: boolean
}

/** Validates, approves, shows and runs a template; answers a line for the person and the problems that stand. */
export async function openTemplate($: EngineInterface, located: Located, options: OpenOptions = {}): Promise<Opened> {
  if (located.problem !== undefined) return { text: located.problem, problems: [located.problem], isShown: false }
  const invalid = validateTemplate(located.raw)
  if (invalid.length > 0) {
    return {
      text: `Template "${located.name}"${located.path === undefined ? '' : ` (${located.path})`} is not valid:\n${invalid.map(p => `- ${p}`).join('\n')}`,
      problems: invalid,
      isShown: false,
    }
  }
  const template = located.raw as GenuiTemplate
  const root = await sessionRoot($)
  if (!(await ensureApproved($, root, located, template, options))) {
    return { text: `Template "${located.name}" was not run.`, problems: ['not approved'], isShown: false }
  }
  const ref = { ...RUNS, id: located.name }
  const previous = await read($, ref)
  const isSameSources = previous !== undefined && (await fingerprint(previous.template.sources)) === (await fingerprint(template.sources))
  const run: GenuiTemplateRun = {
    name: located.name,
    origin: located.origin,
    root,
    template,
    errors: [],
    isLoading: isSameSources && previous?.isLoading === true,
    ...(isSameSources && previous?.loadingSince !== undefined ? { loadingSince: previous.loadingSince } : {}),
    ...(located.path === undefined ? {} : { path: located.path }),
    ...(isSameSources && previous?.data !== undefined ? { data: previous.data } : {}),
  }
  await $.state.set(ref, run)
  await update($, latest, () => ({ kind: 'template' as const, name: located.name }))
  if (options.isReload !== true) await $.ui.open({ id: PANE, title: template.title }).catch(() => undefined)
  if (!(await refreshTemplate($, located.name, { resetForm: true }))) {
    return { text: stillRunning(template.title), problems: [], isShown: true, isStillRunning: true }
  }
  const after = (await read($, ref)) ?? run
  const problems = [...after.errors, ...templateView(after).problems]
  const took = ((after.durationMs ?? 0) / 1000).toFixed(1)
  const text =
    problems.length === 0
      ? `"${template.title}" updated in ${took}s.`
      : `"${template.title}": ${problems.length} problem(s):\n${problems.map(p => `- ${p}`).join('\n')}`
  return { text, problems, isShown: true }
}

const stillRunning = (title: string) => `"${title}" is still running; the pane updates when it finishes.`

/**
 * Retry, a refresh button and `/genui refresh`: the template read again from
 * its file and opened (asking again only if its commands or prompts changed);
 * a preview, which has no file, runs its stored template again.
 */
export async function reloadTemplate($: EngineInterface, name: string): Promise<string> {
  const ref = { ...RUNS, id: name }
  const run = await read($, ref)
  if (run === undefined) return `No run of "${name}".`
  if (run.origin === 'preview') {
    return (await refreshTemplate($, name, { resetForm: true })) ? `Refreshed "${name}".` : stillRunning(run.template.title)
  }
  const located = await locate($, name)
  const opened = located === undefined ? undefined : await openTemplate($, located, { isReload: true })
  if (opened === undefined || !opened.isShown) {
    const why = opened?.text ?? `No template "${name}" any more.`
    await update($, ref, current => ({ ...(current ?? run), errors: [why] }))
    return why
  }
  return opened.isStillRunning === true ? opened.text : `Refreshed "${name}".`
}

/** `/genui init <name>`: copies a built-in template into the project. */
export async function initTemplate($: EngineInterface, name: string): Promise<string> {
  const builtin = NAME.test(name) && Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined
  if (builtin === undefined) return `No built-in template "${name}". Built-in: ${Object.keys(BUILTINS).join(', ')}.`
  const path = `${await sessionRoot($)}/.claude/genui/${name}.json`
  if (await $.fs.exists(path).catch(() => false)) return `${path} already exists.`
  await $.fs.write(path, `${JSON.stringify(builtin, null, 2)}\n`)
  return `Wrote ${path}. Edit it, then open it with /genui ${name}.`
}

/** The preview tool: a template object (approved like a project's) or a saved one by name. */
export async function previewTemplate($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  let located: Located | undefined
  if (input.template !== undefined) located = { name: '_preview', origin: 'preview', raw: input.template }
  else if (typeof input.name === 'string') located = await locate($, input.name)
  if (located === undefined) return 'Give a template object, or the name of a saved template.'
  return (await openTemplate($, located, { requireApproval: true })).text
}

/** One second of a template on screen: refreshes it once its period has passed (the form kept). */
export async function tickTemplate($: EngineInterface, name: string): Promise<void> {
  const run = await read($, { ...RUNS, id: name })
  const every = run?.template.refreshSeconds ?? 0
  if (run === undefined || every <= 0) return
  const panes = await $.ui.panes().catch(() => [])
  if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) return
  if ((await $.clock.now()) - (run.updatedAt ?? 0) < Math.max(MIN_REFRESH_SECONDS, every) * 1000) return
  await refreshTemplate($, name, { resetForm: false })
}
