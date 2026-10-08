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

const numbersIn = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map(m => Number(m[1])))]

const isSame = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i])

const setUp = ($: EngineInterface) => {
  setup ??= (async () => {
    const session = await $.session.id()
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    const edits = `/private/tmp/image-shelf/${session.slice(0, 8)}`
    await $.process.run(['mkdir', '-p', edits])
    const [program, term, tmux, tmuxPane, home] = await Promise.all([$.env.get('TERM_PROGRAM'), $.env.get('TERM'), $.env.get('TMUX'), $.env.get('TMUX_PANE'), $.env.get('HOME')])
    const canDraw = !tmux && (/^(ghostty|wezterm)$/i.test(program ?? '') || /kitty|ghostty/i.test(term ?? ''))
    return { edits, tmp: `/private/tmp/claude-${uid}`, session, canDraw, tmuxPane: tmux ? (tmuxPane ?? '') : '', home: home ?? '' }
  })()
  return setup
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
  await setUp($)
  const ns = numbersIn(text)
  if (!isSame(ns, await read($, inBox))) await update($, inBox, () => ns)
  const known = await read($, shots)
  for (const n of ns) {
    if (capturing.has(n) || known.some(s => s.n === n)) continue
    capturing.add(n)
    void capture($, n).finally(() => capturing.delete(n))
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
      await writeShelf($, (await read($, shots)).filter(s => ns.includes(s.n)), lastShown && ns.length > 0, lastColumns)
      const { edits } = await setUp($)
      const told = Number(/"rows":(\d+)/.exec(await $.fs.read(`${edits}/layout.json`).catch(() => ''))?.[1] ?? PANEL_ROWS)
      if (told !== (await read($, roomRows))) await update($, roomRows, () => told)
    }
  } finally {
    isTicking = false
  }
}

const open = async ($: EngineInterface, n: number) => {
  const shot = (await read($, shots)).find(s => s.n === n)
  if (shot === undefined || shot.copy === '') {
    $.ui.toast(`Image #${n} 還在準備，等一下再點`)
    return
  }
  // The editor writes the edit over the copy; its new mtime marks it edited.
  const binary = await buildEditor($)
  if (binary === undefined) {
    await $.process.run(['open', '-a', 'Preview', shot.copy])
    return
  }
  await $.process.run([binary, `${$.plugin.root}/editor/editor.html`, shot.copy, shot.copy, `Image #${n}`, 'zh-Hant'], { timeoutMs: 3_600_000 }).catch(() => undefined)
}

const pictureOf = async ($: EngineInterface, shot: Shot) => {
  const held = thumbs.get(shot.thumb)
  if (held !== undefined) return held
  const { base64 } = await $.fs.read(shot.thumb, { as: 'bytes' })
  thumbs.set(shot.thumb, base64)
  return base64
}

// A Swift program of the mod's, compiled once per version of its source and named by it.
const build = async ($: EngineInterface, source: string, name: string) => {
  const text = await $.fs.read(source)
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')
  const binary = `/private/tmp/image-shelf/bin/${name}-${digest}`
  if (await $.fs.exists(binary).catch(() => false)) return binary
  await $.process.run(['mkdir', '-p', '/private/tmp/image-shelf/bin'])
  const part = `${binary}.${crypto.randomUUID().slice(0, 8)}`
  const made = await $.process.run(['xcrun', 'swiftc', '-O', source, '-o', part], { timeoutMs: 180_000 }).catch(() => undefined)
  if (made?.exitCode !== 0) return undefined
  return (await $.process.run(['mv', '-f', part, binary])).exitCode === 0 ? binary : undefined
}

// The floating window, and the markup editor (editor/, from paste-preview, MIT).
const buildPanel = ($: EngineInterface) => build($, `${$.plugin.root}/panel/shelf.swift`, 'shelf')
let editor: Promise<string | undefined> | undefined
const buildEditor = ($: EngineInterface) => {
  editor ??= build($, `${$.plugin.root}/editor/editor.swift`, 'editor').catch(() => undefined)
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
const startPanel = ($: EngineInterface, shelfFile: string) => {
  panel ??= (async () => {
    const binary = await buildPanel($)
    if (binary === undefined) {
      $.ui.toast('image-shelf：浮動視窗編譯失敗（需要 Xcode Command Line Tools）')
      return undefined
    }
    isPanelUp = true
    void (async () => {
      try {
        for await (const _ of $.process.spawn({ argv: [binary, shelfFile] })) { /* it says nothing */ }
      } catch {}
      isPanelUp = false
      panel = undefined
    })()
    return binary
  })().catch(() => undefined)
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
  const items = list.filter(s => s.thumb !== '').map(s => ({ n: s.n, thumb: s.thumb, copy: s.copy, edited: s.isEdited }))
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
    $.clock.every(700, () => void tick($).catch(() => undefined))
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await sync($, box.text).catch(() => undefined)
    return box
  })

  // At Enter: Claude is pointed at each edited copy. The original paste still goes along;
  // the note says which one to trust.
  on('prompt.submit', async ($, e, next) => {
    await watchEdits($).catch(() => undefined)
    const ns = numbersIn(e.text)
    const edited = (await read($, shots).catch(() => [] as Shot[])).filter(s => s.isEdited && ns.includes(s.n))
    if (edited.length === 0) return next(e)
    const notes = edited.map(s => `The person edited [Image #${s.n}] in Preview before sending (drew on, cropped or annotated it). The attached original is the unedited paste; the edited picture is ${s.copy}. Read that file and work from the edited version.`)
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { canDraw } = await setUp($)
    const ns = await read($, inBox)
    const all = await read($, shots)
    const isShown = e.surface === 'terminal' && !e.props.hasSurvey && ns.length > 0
    lastColumns = e.props.bodyColumns
    lastMaxRows = e.props.maxRows
    lastShown = isShown
    if (!canDraw) void writeShelf($, ns.flatMap(n => all.filter(s => s.n === n)), isShown, e.props.bodyColumns).catch(() => undefined)
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
          const label = `#${n}${shot?.isEdited ? ' 已編輯' : ''}`
          const hotkey = i < 9 ? { hotkey: String(i + 1) } : {}
          const png = canDraw && shot !== undefined && shot.thumb !== '' ? await pictureOf($, shot).catch(() => undefined) : undefined
          return (
            <Box key={`shot-${n}`} flexDirection="column">
              {png !== undefined && shot !== undefined && (
                <Image key={`img-${n}`} source={{ png }} columns={columnsOf(shot, rows)} rows={rows} alt={`#${n}`} />
              )}
              {shot === undefined
                ? <Text key={`wait-${n}`} dimColor>#{n} …</Text>
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
