import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shot } from '../types'

// image-shelf: each [Image #N] in the prompt box shows on a shelf at the left above the
// prompt. Nothing opens on paste. Pressing an image opens a copy of it in Preview, whose
// Markup tools draw on it; once Preview saves (Cmd+S, or on close), the shelf marks it
// edited and, at Enter, Claude is told to read the edited copy.
//
// Claude Code writes each paste to /private/tmp/claude-<uid>/<project>/<session>/images/
// <N>.png; that is its internal layout, not an API. The picture itself is drawn only
// where the terminal can (Ghostty, kitty, WezTerm, outside tmux); elsewhere the shelf
// shows a button per image, and a floating window of our own (panel/shelf.swift, as a
// desktop pet sits over the screen) shows the pictures over blank rows the band holds.

const shots = atom({ plugin: 'image-shelf', key: 'shots' } as const, [])
const inBox = atom({ plugin: 'image-shelf', key: 'inBox' } as const, [])
// Rows the floating window's grid takes; the band holds that many blank rows.
const roomRows = atom({ plugin: 'image-shelf', key: 'roomRows' } as const, 4)

const PLACEHOLDER = /\[Image #(\d+)\]/g
// A terminal cell is about twice as tall as it is wide.
const CELL = 2
const ROWS = 6

type Setup = { edits: string; tmp: string; session: string; canDraw: boolean; tmuxPane: string; home: string }

// Rows the floating window's pictures take, and what sits under the band down to the
// pane's bottom (the buttons sit above the pictures): a spacer, the prompt between its two rules,
// and the status lines. ~/.config/image-shelf.json may say otherwise (dx, dy in points).
const PANEL_ROWS = 4
type Tuning = { dx: number; dy: number; statusLines: number; spacer: number }
const TUNING: Tuning = { dx: 0, dy: -5.5, statusLines: 1, spacer: 0 }

// Module variables start over on a hot reload; everything a drawing reads is in $.state.
let setup: Promise<Setup> | undefined
let images: string | undefined
let isTicking = false
let panel: Promise<string | undefined> | undefined
let isPanelUp = false
let lastShelf = ''
// What the band last drew with, so the tick can keep the floating window in step as
// the prompt grows or shrinks between draws.
let lastColumns = 80
let lastMaxRows = 0
let lastShown = false
const capturing = new Set<number>()
const thumbs = new Map<string, string>()

// What went wrong, for a session whose shelf stays empty: `claude --debug` shows it in the
// debug log, and this file has it either way. A failure is not kept: the next look tries again.
const ERRORS = '/private/tmp/image-shelf/errors.log'
// A Swift build that failed is tried again this long after, not at every tick.
const RETRY_MS = 30_000
const reported = new Map<string, string>()
let writing = Promise.resolve()
let setupFailures = 0

const report = ($: EngineInterface, where: string, err: unknown) => {
  const text = err instanceof Error ? err.message : String(err)
  // The tick comes every 0.7 s: a failure that keeps happening is written once.
  if (reported.get(where) === text) return
  reported.set(where, text)
  $.ui.log(`image-shelf ${where}: ${text}`, { to: 'debug' })
  writing = writing.then(async () => {
    const session = await $.session.id().catch(() => '-')
    const old = await $.fs.read(ERRORS).catch(() => '')
    const lines = [...old.split('\n').filter(line => line !== ''), `${new Date().toISOString()} ${session.slice(0, 8)} ${where}: ${text}`]
    await $.fs.write(ERRORS, `${lines.slice(-200).join('\n')}\n`)
  }).catch(() => undefined)
}

// Working again: the same failure, should it come back, is written again.
const recovered = (where: string) => void reported.delete(where)

const numbersIn = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map(m => Number(m[1])))]

// HEIC / HEIF photos (what an iPhone takes): Claude Code does not take them as images, so a
// path to one stays text in the box. Such a path, typed, pasted or dragged in (quoted, or with
// spaces escaped), gets a converted PNG on the shelf like a paste, under a number of its own
// below zero so it never meets an [Image #N].
const HEIC_PATH = /'([^'\n]+\.hei[cf])'|"([^"\n]+\.hei[cf])"|((?:~|\/)(?:\\.|[^\s'"\\])+\.hei[cf])(?![\w.])/gi
const heicIds = new Map<string, number>()
const heicPaths = new Map<number, string>()

// The HEIC paths a prompt names, as files: quotes taken off, escapes undone, ~ made home.
export const heicPathsIn = (text: string, home: string) => [...new Set([...text.matchAll(HEIC_PATH)].map(m => {
  const raw = m[1] ?? m[2] ?? (m[3] ?? '').replace(/\\(.)/g, '$1')
  return raw.startsWith('~/') ? `${home}${raw.slice(1)}` : raw
}))]

const heicsIn = async ($: EngineInterface, text: string) => {
  const { home } = await setUp($)
  const found: { n: number; path: string }[] = []
  for (const path of heicPathsIn(text, home)) {
    if (!(await $.fs.exists(path).catch(() => false))) continue
    let n = heicIds.get(path)
    if (n === undefined) {
      n = -(heicIds.size + 1)
      heicIds.set(path, n)
      heicPaths.set(n, path)
    }
    found.push({ n, path })
  }
  return found
}

const isSame = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i])

// Claude Code can move a session into its background host, which starts it again without
// the terminal's environment (no TMUX, TMUX_PANE, TERM_PROGRAM). The host still runs under
// the claude the pane started, so the pane is the one whose shell is among our ancestors.
const paneOfAncestors = async ($: EngineInterface) => {
  const tmux = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
  let bin = 'tmux'
  for (const path of tmux) if (await $.fs.exists(path).catch(() => false)) { bin = path; break }
  const [panes, tree, me] = await Promise.all([
    $.process.run([bin, 'list-panes', '-a', '-F', '#{pane_pid} #{pane_id}']),
    $.process.run(['ps', '-A', '-o', 'pid=,ppid=']),
    $.process.run(['sh', '-c', 'echo $PPID']),
  ])
  if (panes.exitCode !== 0 || tree.exitCode !== 0) return ''
  const paneOf = new Map(panes.stdout.trim().split('\n').map(l => l.trim().split(' ') as [string, string]))
  const parentOf = new Map(tree.stdout.trim().split('\n').map(l => l.trim().split(/\s+/) as [string, string]))
  let pid = me.stdout.trim()
  for (let i = 0; i < 40 && pid !== '' && pid !== '0' && pid !== '1'; i++) {
    const pane = paneOf.get(pid)
    if (pane !== undefined) return pane
    pid = parentOf.get(pid) ?? ''
  }
  return ''
}

const setUp = ($: EngineInterface) => {
  if (setup !== undefined) return setup
  const attempt = (async () => {
    const session = await $.session.id()
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    const edits = `/private/tmp/image-shelf/${session.slice(0, 8)}`
    await $.process.run(['mkdir', '-p', edits])
    const [program, term, tmux, envPane, home] = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('TERM'), $.env.get('TMUX'), $.env.get('TMUX_PANE'), $.env.get('HOME')])
    const tmuxPane = tmux ? (envPane ?? '') : await paneOfAncestors($).catch(() => '')
    const canDraw = !tmux && tmuxPane === '' && (/^(ghostty|wezterm)$/i.test(program ?? '') || /kitty|ghostty/i.test(term ?? ''))
    return { edits, tmp: `/private/tmp/claude-${uid}`, session, canDraw, tmuxPane, home: home ?? '' }
  })()
  setup = attempt
  attempt.then(() => {
    setupFailures = 0
    recovered('setup')
  }, err => {
    if (setup === attempt) setup = undefined
    setupFailures += 1
    report($, 'setup', err)
    if (setupFailures === 5) $.ui.toast(`image-shelf 啟動失敗，還在重試（記錄在 ${ERRORS}）`)
  })
  return attempt
}

// A /clear (or a resume into another conversation) goes on under a new session id, and
// Claude Code puts the pastes in that session's folder: what was tied to the old one starts over.
const forget = async ($: EngineInterface) => {
  const was = await setup?.catch(() => undefined)
  setup = undefined
  images = undefined
  lastShelf = ''
  capturing.clear()
  thumbs.clear()
  await update($, shots, () => [])
  await update($, inBox, () => [])
  // The old floating window reads the old shelf.json; the next paste starts one for the new.
  if (was !== undefined) await $.process.run(['pkill', '-f', `image-shelf/bin/shelf-[0-9a-f]+ ${was.edits}/shelf.json`]).catch(() => undefined)
}

// <tmp>/<project>/<session>/images, whichever project folder holds this session.
const imagesOf = async ($: EngineInterface, tmp: string, session: string) => {
  for (const entry of await $.fs.list(tmp).catch(() => [])) {
    if (entry.kind === 'file') continue
    const at = `${tmp}/${entry.name}/${session}/images`
    if (await $.fs.exists(at).catch(() => false)) return at
  }
  return undefined
}

// Claude Code's copy lands a moment after the placeholder does.
const engineCopy = async ($: EngineInterface, n: number) => {
  const { tmp, session } = await setUp($)
  for (let attempt = 0; attempt < 120; attempt++) {
    images ??= await imagesOf($, tmp, session)
    if (images !== undefined) {
      const entry = (await $.fs.list(images).catch(() => [])).find(e => new RegExp(`^${n}\\.[a-z]+$`).test(e.name))
      if (entry !== undefined) return `${images}/${entry.name}`
    }
    await $.clock.sleep(50)
  }
  return undefined
}

// Size and a small PNG for the shelf: a screenshot can be 10 MB, the shelf needs 480 px.
const look = async ($: EngineInterface, n: number, file: string, gen: number) => {
  const { edits } = await setUp($)
  const info = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])
  const width = Number(/pixelWidth: (\d+)/.exec(info.stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight: (\d+)/.exec(info.stdout)?.[1] ?? 0)
  const thumb = `${edits}/${n}.thumb-${gen}.png`
  const made = await $.process.run(['sips', '-s', 'format', 'png', '-Z', '480', file, '--out', thumb])
  return made.exitCode === 0 && width > 0 && height > 0 ? { width, height, thumb } : undefined
}

const mtimeOf = async ($: EngineInterface, file: string) => (await $.fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0

// A new paste: copy it where Preview may write, so the original stays as pasted.
// A HEIC path: a PNG of it where Preview may write (at most 2400 px, a phone photo is 4000).
const captureHeic = async ($: EngineInterface, n: number, source: string) => {
  const { edits } = await setUp($)
  const copy = `${edits}/heic${-n}.png`
  const made = await $.process.run(['sips', '-s', 'format', 'png', '-Z', '2400', source, '--out', copy])
  if (made.exitCode !== 0) return
  const seen = await look($, n, copy, 0)
  const shot: Shot = { n, copy, thumb: seen?.thumb ?? '', madeAt: await mtimeOf($, copy), isEdited: false, gen: 0, width: seen?.width ?? 0, height: seen?.height ?? 0, label: `HEIC ${-n}`, source }
  await update($, shots, list => [...list.filter(s => s.n !== n), shot])
}

const nameOf = (n: number, shot?: Shot) => shot?.label ?? (n < 0 ? `HEIC ${-n}` : `#${n}`)

const capture = async ($: EngineInterface, n: number) => {
  const found = await engineCopy($, n)
  if (found === undefined) return
  const { edits } = await setUp($)
  const copy = `${edits}/${n}.png`
  const made = await $.process.run(['sips', '-s', 'format', 'png', found, '--out', copy])
  if (made.exitCode !== 0) return
  const seen = await look($, n, copy, 0)
  const shot: Shot = { n, copy, thumb: seen?.thumb ?? '', madeAt: await mtimeOf($, copy), isEdited: false, gen: 0, width: seen?.width ?? 0, height: seen?.height ?? 0 }
  await update($, shots, list => [...list.filter(s => s.n !== n), shot])
}

// Preview saved: the copy's mtime moved on. Remake the thumbnail and mark it edited.
const watchEdits = async ($: EngineInterface) => {
  for (const shot of await read($, shots)) {
    if (shot.copy === '') continue
    const at = await mtimeOf($, shot.copy)
    const last = shot.madeAt
    if (at === 0 || at === last) continue
    const gen = shot.gen + 1
    const seen = await look($, shot.n, shot.copy, gen).catch(() => undefined)
    await update($, shots, list => list.map(s => (s.n === shot.n ? { ...s, madeAt: at, isEdited: true, gen, thumb: seen?.thumb ?? s.thumb, width: seen?.width ?? s.width, height: seen?.height ?? s.height } : s)))
  }
}

// Numbers run up through a session, so only an unknown N is a new paste.
const sync = async ($: EngineInterface, text: string) => {
  // No session.start fires after a /clear, so the id is checked on every look at the box.
  if (setup !== undefined && (await setup).session !== (await $.session.id())) await forget($)
  await setUp($)
  const ns = [...numbersIn(text), ...(await heicsIn($, text)).map(h => h.n)]
  if (!isSame(ns, await read($, inBox))) await update($, inBox, () => ns)
  const known = await read($, shots)
  for (const n of ns) {
    if (capturing.has(n) || known.some(s => s.n === n)) continue
    capturing.add(n)
    const source = heicPaths.get(n)
    void (n < 0 && source !== undefined ? captureHeic($, n, source) : capture($, n)).finally(() => capturing.delete(n))
  }
}

const tick = async ($: EngineInterface) => {
  if (isTicking) return
  isTicking = true
  try {
    await sync($, (await $.prompt.read()).text)
    await watchEdits($)
    const { canDraw } = await setUp($)
    if (!canDraw) {
      const ns = await read($, inBox)
      // In the prompt's order, as the band writes it: shots is in the order copies finished.
      const all = await read($, shots)
      await writeShelf($, ns.flatMap(n => all.filter(s => s.n === n)), lastShown && ns.length > 0, lastColumns)
      const { edits } = await setUp($)
      const told = Number(/"rows":(\d+)/.exec(await $.fs.read(`${edits}/layout.json`).catch(() => ''))?.[1] ?? PANEL_ROWS)
      if (told !== (await read($, roomRows))) await update($, roomRows, () => told)
    }
    recovered('tick')
  } finally {
    isTicking = false
  }
}

const open = async ($: EngineInterface, n: number) => {
  const shot = (await read($, shots)).find(s => s.n === n)
  if (shot === undefined || shot.copy === '') {
    $.ui.toast(`${n < 0 ? nameOf(n, shot) : `Image #${n}`} 還在準備，等一下再點`)
    return
  }
  // The editor writes the edit over the copy; its new mtime marks it edited.
  const binary = await buildEditor($)
  if (binary === undefined) {
    await $.process.run(['open', '-a', 'Preview', shot.copy])
    return
  }
  await $.process.run([binary, `${$.plugin.root}/editor/editor.html`, shot.copy, shot.copy, shot.label ?? `Image #${n}`, 'zh-Hant'], { timeoutMs: 3_600_000 }).catch(() => undefined)
}

const pictureOf = async ($: EngineInterface, shot: Shot) => {
  const held = thumbs.get(shot.thumb)
  if (held !== undefined) return held
  const { base64 } = await $.fs.read(shot.thumb, { as: 'bytes' })
  thumbs.set(shot.thumb, base64)
  return base64
}

// What a failed command said: its error lines, or its last lines when it marked none.
const tail = (text: string) => {
  const lines = text.trim().split('\n').map(line => line.trim())
  const errors = lines.filter(line => line.includes('error:'))
  return (errors.length > 0 ? errors : lines).slice(-3).join(' / ')
}

// A Swift program of the mod's, compiled once per version of its source and named by it.
const build = async ($: EngineInterface, source: string, name: string) => {
  const text = await $.fs.read(source)
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')
  const binary = `/private/tmp/image-shelf/bin/${name}-${digest}`
  if (await $.fs.exists(binary).catch(() => false)) return binary
  await $.process.run(['mkdir', '-p', '/private/tmp/image-shelf/bin'])
  const part = `${binary}.${crypto.randomUUID().slice(0, 8)}`
  const made = await $.process.run(['xcrun', 'swiftc', '-O', source, '-o', part], { timeoutMs: 180_000 })
  if (made.exitCode !== 0) throw new Error(`swiftc ${name}.swift: ${tail(made.stderr)}`)
  const moved = await $.process.run(['mv', '-f', part, binary])
  if (moved.exitCode !== 0) throw new Error(`mv ${name}: ${tail(moved.stderr)}`)
  return binary
}

// The floating window, and the markup editor (editor/, from paste-preview, MIT).
const buildPanel = ($: EngineInterface) => build($, `${$.plugin.root}/panel/shelf.swift`, 'shelf')
let editor: Promise<string | undefined> | undefined
let editorRetryAt = 0
const buildEditor = ($: EngineInterface) => {
  if (editor === undefined && Date.now() < editorRetryAt) return Promise.resolve(undefined)
  editor ??= build($, `${$.plugin.root}/editor/editor.swift`, 'editor').catch(err => {
    report($, 'editor', err)
    editorRetryAt = Date.now() + RETRY_MS
    editor = undefined
    return undefined
  })
  return editor
}

const tuningOf = async ($: EngineInterface, home: string): Promise<Tuning> => {
  const text = await $.fs.read(`${home}/.config/image-shelf.json`).catch(() => '')
  try {
    return { ...TUNING, ...(text === '' ? {} : JSON.parse(text)) }
  } catch {
    return TUNING
  }
}

// Started the first time there is something to show; it quits with Claude Code.
let panelRetryAt = 0
let isPanelFailureShown = false
const startPanel = ($: EngineInterface, shelfFile: string) => {
  if (panel === undefined && Date.now() < panelRetryAt) return Promise.resolve(undefined)
  panel ??= (async () => {
    const binary = await buildPanel($)
    isPanelUp = true
    const startedAt = Date.now()
    void (async () => {
      const child = $.process.spawn({ argv: [binary, shelfFile] })
      try {
        for await (const _ of child) { /* it says nothing */ }
        const { code, signal } = await child.result
        // pkill, on a reload or a /clear, ends it with SIGTERM; it quits by itself with 0.
        const isCrash = signal === null ? code !== 0 : !['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'].includes(signal)
        if (isCrash) {
          report($, 'panel', `shelf ended with ${signal ?? `code ${code}`}`)
          // One that dies right away waits before it starts again, not 0.7 s.
          if (Date.now() - startedAt < 5_000) panelRetryAt = Date.now() + RETRY_MS
        } else if (Date.now() - startedAt >= 5_000) {
          recovered('panel')
        }
      } catch (err) {
        report($, 'panel', err)
        panelRetryAt = Date.now() + RETRY_MS
      }
      isPanelUp = false
      panel = undefined
    })()
    return binary
  })().catch(err => {
    report($, 'panel', err)
    if (!isPanelFailureShown) $.ui.toast('image-shelf：浮動視窗編譯失敗（需要 Xcode Command Line Tools）')
    isPanelFailureShown = true
    panelRetryAt = Date.now() + RETRY_MS
    panel = undefined
    return undefined
  })
  return panel
}

// Display width in cells: CJK and emoji take two.
const widthOf = (text: string) => [...text].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0)

const promptRows = (text: string, columns: number) => text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil((widthOf(line) + 2) / Math.max(10, columns))), 0)

// What the floating window reads: the pictures, and where the band's blank rows are.
const writeShelf = async ($: EngineInterface, list: Shot[], isVisible: boolean, columns: number) => {
  const { edits, tmuxPane, home } = await setUp($)
  const tuning = await tuningOf($, home)
  const text = isVisible ? (await $.prompt.read().catch(() => ({ text: '' }))).text : ''
  const rowsBelow = tuning.spacer + 2 + promptRows(text, columns) + tuning.statusLines
  const items = list.filter(s => s.thumb !== '').map(s => ({ n: s.n, thumb: s.thumb, copy: s.copy, edited: s.isEdited, ...(s.label === undefined ? {} : { label: s.label }) }))
  const editorBinary = items.length > 0 ? ((await buildEditor($)) ?? '') : ''
  const shelf = JSON.stringify({ visible: isVisible && items.length > 0, items, rows: PANEL_ROWS, rowsBelow, editor: editorBinary, page: `${$.plugin.root}/editor/editor.html`, tmuxPane, maxRows: lastMaxRows, dx: tuning.dx, dy: tuning.dy })
  const file = `${edits}/shelf.json`
  if (shelf !== lastShelf) {
    lastShelf = shelf
    await $.fs.write(file, shelf)
  }
  // Started again if it quit (or was stopped) while there are pictures to show.
  if (items.length > 0 && !isPanelUp) void startPanel($, file)
}

// Same height for all, `rows` tall, as wide as the picture's shape asks.
const columnsOf = (shot: Shot, rows: number) => Math.max(4, Math.min(48, Math.round((rows * CELL * shot.width) / shot.height)))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload (or a new version of the mod) brings a fresh panel: the one an earlier load
    // started for this session goes, so an edited panel/shelf.swift takes effect.
    void setUp($).then(({ edits }) => $.process.run(['pkill', '-f', `image-shelf/bin/shelf-[0-9a-f]+ ${edits}/shelf.json`])).catch(() => undefined)
    $.clock.every(700, () => void tick($).catch(err => report($, 'tick', err)))
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await sync($, box.text).catch(err => report($, 'sync', err))
    return box
  })

  // At Enter: Claude is pointed at each edited copy. The original paste still goes along;
  // the note says which one to trust. A HEIC photo is not attached at all, so Claude is
  // pointed at its PNG (made now if Enter came before the shelf had it).
  on('prompt.submit', async ($, e, next) => {
    await watchEdits($).catch(() => undefined)
    const ns = numbersIn(e.text)
    const heics = await heicsIn($, e.text).catch(() => [] as { n: number; path: string }[])
    for (const h of heics) {
      if (!(await read($, shots).catch(() => [] as Shot[])).some(s => s.n === h.n && s.copy !== '')) await captureHeic($, h.n, h.path).catch(() => undefined)
    }
    const all = await read($, shots).catch(() => [] as Shot[])
    const notes = all.filter(s => s.isEdited && ns.includes(s.n)).map(s => `The person edited [Image #${s.n}] in Preview before sending (drew on, cropped or annotated it). The attached original is the unedited paste; the edited picture is ${s.copy}. Read that file and work from the edited version.`)
    for (const h of heics) {
      const s = all.find(x => x.n === h.n)
      if (s === undefined || s.copy === '') continue
      notes.push(`The person attached the HEIC photo ${h.path}. Claude Code cannot read HEIC files, so image-shelf converted it to PNG${s.isEdited ? ' and the person then drew on or annotated it' : ''}: ${s.copy}. Read that file to see the photo.`)
    }
    if (notes.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Not set up yet (setUp has written why, and tries again): the band is left as it is.
    const ready = await setUp($).catch(() => undefined)
    if (ready === undefined) return next(e)
    const { canDraw } = ready
    const ns = await read($, inBox)
    const all = await read($, shots)
    const isShown = e.surface === 'terminal' && !e.props.hasSurvey && ns.length > 0
    lastColumns = e.props.bodyColumns
    lastMaxRows = e.props.maxRows
    lastShown = isShown
    if (!canDraw) void writeShelf($, ns.flatMap(n => all.filter(s => s.n === n)), isShown, e.props.bodyColumns).catch(err => report($, 'shelf', err))
    if (e.surface !== 'terminal' || e.props.hasSurvey || ns.length === 0) return next(e)
    const { Box, Text, Button, Image } = $.ui.resolve(e)
    const rows = Math.max(3, Math.min(ROWS, e.props.maxRows - 2))

    // Where the terminal cannot draw, blank rows for the floating window to cover.
    const room = !canDraw && all.some(s => ns.includes(s.n) && s.thumb !== '')
      ? <Box key="room" height={Math.max(1, Math.min(PANEL_ROWS, e.props.maxRows))} />
      : null

    // Here the floating window shows the pictures and takes the clicks: only its room.
    if (!canDraw) return room === null ? next(e) : <Box flexDirection="column">{room}</Box>

    return (
      <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} justifyContent="flex-start">
        {await Promise.all(ns.map(async (n, i) => {
          const shot = all.find(s => s.n === n)
          const label = `${nameOf(n, shot)}${shot?.isEdited ? ' 已編輯' : ''}`
          const hotkey = i < 9 ? { hotkey: String(i + 1) } : {}
          const png = canDraw && shot !== undefined && shot.thumb !== '' ? await pictureOf($, shot).catch(() => undefined) : undefined
          return (
            <Box key={`shot-${n}`} flexDirection="column">
              {png !== undefined && shot !== undefined && (
                <Image key={`img-${n}`} source={{ png }} columns={columnsOf(shot, rows)} rows={rows} alt={nameOf(n, shot)} />
              )}
              {shot === undefined
                ? <Text key={`wait-${n}`} dimColor>{nameOf(n)} …</Text>
                : <Button key={`open-${n}`} label={`🖼 ${label}`} plain {...hotkey} onPress={() => void open($, n)} />}
            </Box>
          )
        }))}
      </Box>
      {room}
      </Box>
    )
  })
}
