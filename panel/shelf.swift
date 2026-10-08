// image-shelf panel: a borderless floating window that shows the pasted images over the
// blank rows the mod reserves above Claude Code's prompt, for terminals that cannot draw
// pictures themselves (iTerm2, tmux). Clicking a picture opens it in Preview.
//
// The mod writes a JSON file (the only argument) whenever the shelf changes; this polls
// it, finds where those rows are on screen, and follows the terminal window. It quits
// when Claude Code (its parent) goes away.
//
// Where the rows are: iTerm2 says which session is in front and where its window is
// (AppleScript); tmux says the pane's place and the size of a cell in pixels; without
// tmux the tty's own size in pixels says the cell. Rows are counted up from the
// window's bottom edge.

import AppKit

struct Item: Decodable { let n: Int; let thumb: String; let copy: String; let edited: Bool }
struct Shelf: Decodable {
  let visible: Bool
  let items: [Item]
  // Blank rows the band holds for the pictures, and the rows under them to the pane's bottom.
  let rows: Int
  let rowsBelow: Int
  let tmuxPane: String
  // Rows the band may take at most (Claude Code caps it; the collapse row comes first).
  let maxRows: Int
  let dx: Double
  let dy: Double
  // The markup editor and its page; empty until built.
  var editor: String? = nil
  var page: String? = nil
}

// Where the band's picture rows end (their bottom edge, y down), how wide they are, a
// row's height, and how many rows there are above that edge within the pane.
struct Place { let x: Double; let bottom: Double; let width: Double; let cellW: Double; let cellH: Double; let roomRows: Int; let collapseTop: Double? }

final class Thumb: NSImageView {
  var file = ""
  var n = 0
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  // The markup editor on the copy, writing the edit over it; Preview where it is not built.
  override func mouseDown(with event: NSEvent) {
    if let editor = shelf?.editor, !editor.isEmpty, let page = shelf?.page {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: editor)
      p.arguments = [page, file, file, "Image #\(n)", "zh-Hant"]
      p.standardOutput = FileHandle.nullDevice
      if (try? p.run()) != nil { return }
    }
    let preview = URL(fileURLWithPath: "/System/Applications/Preview.app")
    NSWorkspace.shared.open([URL(fileURLWithPath: file)], withApplicationAt: preview, configuration: NSWorkspace.OpenConfiguration())
  }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

final class Panel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// shelf --probe <tmux pane> <rows>: the layout the panel would take, for tests.
if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--probe" {
  let pane = CommandLine.arguments[2]
  let probeTmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "tmux"
  let width = Int(sh([probeTmux, "display", "-p", "-t", pane, "#{pane_width}"])) ?? 80
  let lines = sh([probeTmux, "capture-pane", "-p", "-t", pane]).components(separatedBy: "\n")
  if let m = layout(lines, width, Int(CommandLine.arguments[3]) ?? 4) {
    print("rule=\(m.rule) collapse=\(m.collapse.map(String.init) ?? "-") tile=\(m.tileRows) band=\(m.band)")
  } else { print("none") }
  exit(0)
}
// shelf --chrome <x> <top> <height> <row a> <row b> <cellH>: the measured row offset, for tests.
if CommandLine.arguments.count == 8 && CommandLine.arguments[1] == "--chrome" {
  let a = CommandLine.arguments.dropFirst(2).compactMap(Double.init)
  print(measureChrome(x: a[0], top: a[1], height: a[2], rows: (a[3], a[4]), cellH: a[5]).map { String($0) } ?? "none")
  exit(0)
}
let shelfPath = CommandLine.arguments[1]
let parent = getppid()
// The newest panel for a shelf wins: a reloaded mod starts another, and this one then goes.
let pidPath = (shelfPath as NSString).deletingLastPathComponent + "/panel.pid"
let me = String(getpid())
try? me.write(toFile: pidPath, atomically: true, encoding: .utf8)

let panel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
panel.isOpaque = false
// Not quite clear: macOS lets clicks and scrolls fall through a window's fully clear
// pixels, so the gaps between pictures would go to the terminal underneath.
panel.backgroundColor = NSColor(white: 0, alpha: 0.01)
panel.hasShadow = false
panel.level = .floating
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
let content = NSView()
panel.contentView = content

var lastText = ""
var shelf: Shelf?
var images: [String: NSImage] = [:]
var drawnKey = ""

func sh(_ argv: [String]) -> String {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: argv[0])
  p.arguments = Array(argv.dropFirst())
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return "" }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

let tmuxPath = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "tmux"

// Claude Code's own terminal, for when it runs outside tmux.
let parentTty: String = {
  let name = sh(["/bin/ps", "-o", "tty=", "-p", String(parent)])
  return name.isEmpty || name == "??" ? "" : "/dev/\(name)"
}()

let frontQuery = """
  tell application "iTerm2"
    set w to current window
    set b to bounds of w
    return (tty of current session of w) & "|" & (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & "," & (count of tabs of w)
  end tell
  """

// The front iTerm2 session's tty, its window's bounds (x1, y1, x2, y2; y down) and its
// number of tabs. Run as
// osascript, off the main thread (NSAppleScript belongs to the main thread).
func frontSession() -> (tty: String, bounds: [Double])? {
  let text = sh(["/usr/bin/osascript", "-e", frontQuery])
  let parts = text.split(separator: "|", maxSplits: 1).map(String.init)
  guard parts.count == 2 else { return nil }
  let numbers = parts[1].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
  return numbers.count == 5 ? (parts[0], numbers) : nil
}

// Test mode (a file "force.on" beside the shelf): the window of the tmux client attached
// to the pane's session is used whether or not it is in front, and the panels sit just
// above that window instead of floating, so a test runs behind whatever else is open.
let forcePath = (shelfPath as NSString).deletingLastPathComponent + "/force.on"
var isForced = false
var forcedWindow: Int = 0

func sessionByTty(_ tty: String) -> (tty: String, bounds: [Double])? {
  let text = sh(["/usr/bin/osascript", "-e", """
    tell application "iTerm2"
      repeat with w in windows
        if (tty of current session of w) is "\(tty)" then
          set b to bounds of w
          return (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & "," & (count of tabs of w)
        end if
      end repeat
    end tell
    """])
  let numbers = text.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
  guard numbers.count == 5 else { return nil }
  let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  forcedWindow = all.first { w in
    guard (w[kCGWindowOwnerName as String] as? String) == "iTerm2", let r = w[kCGWindowBounds as String] as? [String: Double] else { return false }
    return abs((r["X"] ?? -1) - numbers[0]) < 2 && abs((r["Y"] ?? -1) - numbers[1]) < 2
  }?[kCGWindowNumber as String] as? Int ?? 0
  return (tty, numbers)
}

// Row offsets measured per window shape (see place()).
var chromes: [String: Double] = [:]

// The rows of light horizontal lines in a strip of the screen 40 points wide at x, from
// top for height points, in points from top; then the offset that puts both of the
// prompt's rules (rows a and b, drawn at mid-row) on lines. Uses screencapture, which the
// terminal's own screen-recording permission covers.
func measureChrome(x: Double, top: Double, height: Double, rows: (Double, Double), cellH: Double) -> Double? {
  let file = NSTemporaryDirectory() + "image-shelf-strip-\(getpid()).png"
  _ = sh(["/usr/sbin/screencapture", "-x", "-R", "\(Int(x)),\(Int(top)),40,\(Int(height))", file])
  defer { try? FileManager.default.removeItem(atPath: file) }
  guard let data = FileManager.default.contents(atPath: file), let rep = NSBitmapImageRep(data: data), rep.pixelsHigh > 0 else { return nil }
  let scale = Double(rep.pixelsHigh) / height
  var lines: [Double] = []
  var y = 0
  while y < rep.pixelsHigh {
    var lit = 0
    for px in stride(from: 0, to: rep.pixelsWide, by: 4) where (rep.colorAt(x: px, y: y)?.brightnessComponent ?? 0) > 0.45 { lit += 1 }
    if lit * 4 >= rep.pixelsWide * 9 / 10 {
      var end = y
      while end + 1 < rep.pixelsHigh {
        var n = 0
        for px in stride(from: 0, to: rep.pixelsWide, by: 4) where (rep.colorAt(x: px, y: end + 1)?.brightnessComponent ?? 0) > 0.45 { n += 1 }
        if n * 4 >= rep.pixelsWide * 9 / 10 { end += 1 } else { break }
      }
      lines.append((Double(y + end) / 2 + 0.5) / scale)
      y = end + 1
    } else { y += 1 }
  }
  for line in lines {
    let chrome = line - (rows.0 + 0.5) * cellH
    let other = chrome + (rows.1 + 0.5) * cellH
    if chrome > -2, lines.contains(where: { abs($0 - other) < 2 }) { return chrome }
  }
  return nil
}

// Screens as the main thread saw them last, for the asking thread.
var screens: [(frame: NSRect, scale: Double)] = []
// What the pane's text said at the last placing, to notice a change nothing else reports
// (the engine showing or dropping a notice row in the band).
var lastMarks = ""
var lastWidth = 80

// The row of the prompt's top rule: of the lines drawn all in "─" across most of the
// pane, the second from the bottom (the last is the rule under the prompt).
// Where the band is, off the pane's own text. The prompt's top rule: of the lines drawn
// all in "─" across most of the pane, the second from the bottom (the last is under the
// prompt). The band's first row: the one where the engine drew its [-]. The pictures
// take every row from there down to the rule (the band, and any hint or notice the engine
// draws under it), at most `most`: they never reach over the transcript, and where the
// engine leaves the band fewer rows (a tall prompt) they come out smaller.
struct Marks { let rule: Int; let under: Int; let collapse: Int?; let tileRows: Int; let band: String }

func layout(_ lines: [String], _ width: Int, _ most: Int) -> Marks? {
  let rules = lines.enumerated().filter { _, line in
    let t = line.trimmingCharacters(in: .whitespaces)
    return t.count >= max(10, width * 6 / 10) && t.allSatisfy { $0 == "─" }
  }.map { $0.offset }
  guard rules.count >= 2 else { return nil }
  let rule = rules[rules.count - 2]
  // Only the rows just above the rule: a line of the transcript ending in "[-]" is not it.
  let collapse = lines[max(0, rule - 8)..<rule].lastIndex { $0.trimmingCharacters(in: .whitespaces).hasSuffix("[-]") }
  let band = lines[max(0, rule - 8)..<rule].map { l -> String in
    let t = l.trimmingCharacters(in: .whitespaces)
    return t.isEmpty ? "_" : (t.hasSuffix("[-]") ? "[-]" : String(t.prefix(6)))
  }.joined(separator: "|")
  let tileRows = collapse.map { min(most, rule - $0) } ?? 0
  return Marks(rule: rule, under: rules[rules.count - 1], collapse: collapse, tileRows: tileRows, band: band)
}

func marks(_ pane: String, _ width: Int, _ most: Int) -> Marks? {
  layout(sh([tmuxPath, "capture-pane", "-p", "-t", pane]).components(separatedBy: "\n"), width, most)
}

let debugOn = FileManager.default.fileExists(atPath: (shelfPath as NSString).deletingLastPathComponent + "/debug.on")
let debugPath = (shelfPath as NSString).deletingLastPathComponent + "/debug.txt"
func note(_ text: String) {
  let line = "\(Date()) \(text)\n"
  if let h = FileHandle(forWritingAtPath: debugPath) { h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile() }
  else { try? line.write(toFile: debugPath, atomically: true, encoding: .utf8) }
}

func place(_ s: Shelf, _ front: String) -> Place? {
  // The screenshot tool takes the front while it runs; the shelf stays for the picture.
  var found: (tty: String, bounds: [Double])?
  if isForced, !s.tmuxPane.isEmpty {
    let name = sh([tmuxPath, "display", "-p", "-t", s.tmuxPane, "#{session_name}"])
    let tty = sh([tmuxPath, "list-clients", "-t", name, "-F", "#{client_tty} #{client_flags}"]).split(separator: "\n").first { !$0.contains("control-mode") }.map { String($0.split(separator: " ")[0]) } ?? ""
    found = sessionByTty(tty)
  } else if front == "com.googlecode.iterm2" || front == "com.apple.screencaptureui" || front == "com.apple.screenshot.launcher" {
    found = frontSession()
  }
  guard let session = found else { return nil }
  let primaryHeight = screens.first?.frame.height ?? 0
  let scale = screens.first { $0.frame.contains(NSPoint(x: session.bounds[0] + 1, y: primaryHeight - session.bounds[3] + 1)) }?.scale ?? 2
  var cellW = 0.0, cellH = 0.0, totalRows = 0.0, paneTop = 0.0, paneLeft = 0.0, paneHeight = 0.0, paneWidth = 0.0
  if !s.tmuxPane.isEmpty {
    // The client is the one in the front iTerm2 session, by its tty: our own control-mode
    // client is attached too, and must not be the one asked about.
    let client = sh([tmuxPath, "list-clients", "-F", "#{client_tty} #{client_cell_width} #{client_cell_height} #{client_height} #{session_name}"])
      .split(separator: "\n").map { $0.split(separator: " ").map(String.init) }.first { $0.first == session.tty }
    let pane = sh([tmuxPath, "display", "-p", "-t", s.tmuxPane, "#{session_name} #{pane_top} #{pane_left} #{pane_height} #{pane_width} #{window_active} #{pane_in_mode} #{window_zoomed_flag} #{pane_active}"]).split(separator: " ").map(String.init)
    guard let c = client, c.count == 5, pane.count == 9, c[4] == pane[0] else { return nil }
    let f = [c[0], c[1], c[2], c[3], pane[1], pane[2], pane[3], pane[4], pane[5], pane[6], pane[7], pane[8]]
    guard f[8] == "1", f[9] == "0" else { return nil }
    // Another pane zoomed over ours hides it.
    if f[10] == "1" && f[11] == "0" { return nil }
    cellW = (Double(f[1]) ?? 0) / scale; cellH = (Double(f[2]) ?? 0) / scale
    totalRows = Double(f[3]) ?? 0
    paneTop = Double(f[4]) ?? 0; paneLeft = Double(f[5]) ?? 0; paneHeight = Double(f[6]) ?? 0; paneWidth = Double(f[7]) ?? 0
  } else {
    guard parentTty == session.tty else { return nil }
    let fd = open(parentTty, O_RDONLY | O_NOCTTY)
    guard fd >= 0 else { return nil }
    var size = winsize()
    let got = ioctl(fd, TIOCGWINSZ, &size)
    close(fd)
    guard got == 0, size.ws_col > 0, size.ws_row > 0, size.ws_xpixel > 0 else { return nil }
    cellW = Double(size.ws_xpixel) / Double(size.ws_col) / scale
    cellH = Double(size.ws_ypixel) / Double(size.ws_row) / scale
    totalRows = Double(size.ws_row); paneHeight = totalRows; paneWidth = Double(size.ws_col)
  }
  guard cellW > 0, cellH > 0 else { return nil }
  let b = session.bounds
  // Where the prompt's top rule is, read off the pane itself in tmux: the mod's count of
  // the prompt's rows misses that a tall prompt is cut short and scrolls inside its box.
  var bottomRow = paneTop + paneHeight - Double(s.rowsBelow)
  var collapseRow: Double?
  var roomRows = s.rows
  var rules: (Int, Int)?
  if !s.tmuxPane.isEmpty {
    // No band drawn (collapsed, or not yet): nothing to show over.
    guard let m = marks(s.tmuxPane, Int(paneWidth), MOST_ROWS), let c = m.collapse, m.tileRows >= 1 else { return nil }
    bottomRow = paneTop + Double(m.rule)
    collapseRow = paneTop + Double(c)
    roomRows = m.tileRows
    rules = (m.rule, m.under)
    lastMarks = "\(m.rule):\(c):\(m.tileRows)"
    lastWidth = Int(paneWidth)
    if debugOn { note("rule=\(m.rule) collapse=\(c) tile=\(m.tileRows) above=\(m.band)") }
  }
  // iTerm2 lays the rows out from the top of the window: under the title bar (and the tab
  // bar, shown once a window has two tabs) and a small margin; what the rows leave over
  // goes to the bottom. Measured: 35 points, and 35 more with the tab bar.
  let statusAbove = s.tmuxPane.isEmpty ? 0.0 : (sh([tmuxPath, "display", "-p", "-t", s.tmuxPane, "#{?#{&&:#{status},#{==:#{status-position},top}},1,0}"]) == "1" ? 1.0 : 0)
  // How far below the window's top the first row starts depends on the window's style (a
  // title bar or none, a tab bar): measured once per window shape off the screen itself,
  // where the prompt's two rules are drawn; the usual 35 points (70 with tabs) otherwise.
  let key = "\(b)|\(cellH)|\(statusAbove)"
  var chrome = chromes[key] ?? (35.0 + (b[4] > 1 ? 35.0 : 0))
  if chromes[key] == nil, let r = rules {
    let x = b[0] + paneLeft * cellW + 2 * cellW
    if let found = measureChrome(x: x, top: b[1], height: b[3] - b[1], rows: (Double(r.0) + statusAbove, Double(r.1) + statusAbove), cellH: cellH) {
      chrome = found
      chromes[key] = found
    }
  }
  let rowTop = { (r: Double) in b[1] + chrome + (r + statusAbove) * cellH }
  return Place(x: b[0] + paneLeft * cellW + s.dx, bottom: rowTop(bottomRow) + s.dy, width: paneWidth * cellW, cellW: cellW, cellH: cellH, roomRows: roomRows, collapseTop: collapseRow.map { rowTop($0) })
}

func image(_ file: String) -> NSImage? {
  if let held = images[file] { return held }
  guard let made = NSImage(contentsOfFile: file) else { return nil }
  images[file] = made
  return made
}

let layoutPath = (shelfPath as NSString).deletingLastPathComponent + "/layout.json"
var toldLines = -1

// One row of tiles the same size, in paste order, as wide as the tmux pane (its border
// lines are the row's ends). More than fit scroll sideways: a trackpad's swipe, or the
// wheel with Shift held. Each picture fits inside its tile whatever its shape.
let GAP = 8.0
let MOST_ROWS = 6
let ASPECT = 1.6

final class Strip: NSScrollView {
  override func scrollWheel(with event: NSEvent) {
    // A mouse wheel with Shift already comes as sideways on macOS; a plain vertical
    // turn with Shift held (some mice) is made sideways here.
    if event.deltaX == 0 && event.modifierFlags.contains(.shift), let cg = event.cgEvent?.copy() {
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: cg.getDoubleValueField(.scrollWheelEventPointDeltaAxis1))
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: 0)
      cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: cg.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1))
      cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: 0)
      if let turned = NSEvent(cgEvent: cg) { return super.scrollWheel(with: turned) }
    }
    // A trackpad's swipe comes in phases (began, changed, ended, then momentum), some with
    // no movement at all; the scroll view needs every one of them to follow the finger.
    let isGesture = event.phase != [] || event.momentumPhase != []
    if isGesture || event.deltaX != 0 { super.scrollWheel(with: event) }
  }
}

let strip = Strip()
strip.drawsBackground = false
strip.hasHorizontalScroller = true
strip.hasVerticalScroller = false
strip.scrollerStyle = .overlay
strip.horizontalScrollElasticity = .allowed
strip.verticalScrollElasticity = .none
strip.autoresizingMask = [.width, .height]
let shelfView = NSView()
strip.documentView = shelfView
content.addSubview(strip)

// The engine draws its own [-] (collapse the band) in the band's last five columns. The
// row of pictures stops short of them, and a patch the terminal's background colour lies
// over them, so the [-] does not show. The colour is iTerm2's profile's, for the light or
// the dark look as macOS has it now.
// A window of its own, one row by five columns, laid over the row where the [-] is found.
let patchPanel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
patchPanel.isOpaque = true
patchPanel.hasShadow = false
patchPanel.level = .floating
patchPanel.ignoresMouseEvents = true
patchPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

func profileColor(_ key: String) -> NSColor? {
  guard let profiles = UserDefaults(suiteName: "com.googlecode.iterm2")?.array(forKey: "New Bookmarks") as? [[String: Any]],
        let c = profiles.first?[key] as? [String: Any],
        let r = (c["Red Component"] as? NSNumber)?.doubleValue,
        let g = (c["Green Component"] as? NSNumber)?.doubleValue,
        let b = (c["Blue Component"] as? NSNumber)?.doubleValue else { return nil }
  return NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
}

func backgroundColor() -> NSColor {
  let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  let separate = (UserDefaults(suiteName: "com.googlecode.iterm2")?.array(forKey: "New Bookmarks") as? [[String: Any]])?.first?["Use Separate Colors for Light and Dark Mode"] as? Bool ?? false
  let key = separate ? (isDark ? "Background Color (Dark)" : "Background Color (Light)") : "Background Color"
  return profileColor(key) ?? profileColor("Background Color") ?? NSColor(srgbRed: 0.08, green: 0.1, blue: 0.12, alpha: 1)
}
var lastCount = 0

func draw(_ s: Shelf, _ p: Place) {
  let shown = s.items.compactMap { item -> (Item, NSImage)? in
    guard let picture = image(item.thumb), picture.size.height > 0 else { return nil }
    return (item, picture)
  }
  let tileRows = p.roomRows
  // The mod holds this many blank rows; it reads this to know.
  if tileRows != toldLines {
    toldLines = tileRows
    try? "{\"rows\":\(tileRows)}".write(toFile: layoutPath, atomically: true, encoding: .utf8)
  }
  let height = Double(tileRows) * p.cellH
  // Five points clear of the row above: CJK glyphs reach a little past their cell.
  let tileH = height - 7
  let tileW = tileH * ASPECT
  let primary = NSScreen.screens[0].frame.height
  let frame = NSRect(x: p.x, y: primary - p.bottom, width: p.width, height: height)
  if panel.frame != frame { panel.setFrame(frame, display: false) }
  let reserved = 5 * p.cellW
  let stripFrame = NSRect(x: 0, y: 0, width: p.width - reserved, height: height)
  if strip.frame != stripFrame { strip.frame = stripFrame }
  if let top = p.collapseTop {
    patchPanel.backgroundColor = backgroundColor()
    // The font's brackets reach past their cell (tight line spacing): a third of a row more
    // above and below, short of the rules, whose strokes sit mid-row.
    let extra = p.cellH * 0.35
    let rect = NSRect(x: p.x + p.width - reserved, y: primary - top - p.cellH - extra, width: reserved, height: p.cellH + 2 * extra)
    if patchPanel.frame != rect { patchPanel.setFrame(rect, display: true) }
    show(patchPanel)
  } else {
    patchPanel.orderOut(nil)
  }
  let key = s.items.map { "\($0.n):\($0.thumb):\($0.edited)" }.joined(separator: ",") + "@\(p.width)x\(height)"
  if key == drawnKey { return }
  drawnKey = key
  shelfView.subviews.forEach { $0.removeFromSuperview() }
  let total = max(p.width - reserved, Double(shown.count) * (tileW + GAP) - GAP)
  shelfView.frame = NSRect(x: 0, y: 0, width: total, height: height)
  for (i, (item, picture)) in shown.enumerated() {
    let x = Double(i) * (tileW + GAP)
    let tile = Thumb(frame: NSRect(x: x, y: 2, width: tileW, height: tileH))
    tile.image = picture
    tile.imageScaling = .scaleProportionallyDown
    tile.file = item.copy
    tile.n = item.n
    tile.wantsLayer = true
    tile.layer?.backgroundColor = NSColor(white: 0.08, alpha: 0.95).cgColor
    tile.layer?.cornerRadius = 4
    tile.layer?.borderWidth = item.edited ? 2 : 1
    tile.layer?.borderColor = (item.edited ? NSColor.systemOrange : NSColor.white.withAlphaComponent(0.35)).cgColor
    tile.layer?.masksToBounds = true
    tile.toolTip = "Image #\(item.n)：點一下標註"
    shelfView.addSubview(tile)
    let badge = NSTextField(labelWithString: item.edited ? " #\(item.n) 已編輯 " : " #\(item.n) ")
    badge.font = .boldSystemFont(ofSize: tileRows <= 2 ? 9 : 11)
    badge.textColor = .white
    badge.drawsBackground = true
    badge.backgroundColor = NSColor.black.withAlphaComponent(0.7)
    badge.sizeToFit()
    badge.frame.origin = NSPoint(x: x + 2, y: 4)
    shelfView.addSubview(badge)
  }
  // A new paste scrolls the row to its end, so the newest picture is in view.
  if shown.count > lastCount {
    strip.contentView.scroll(to: NSPoint(x: max(0, total - (p.width - reserved)), y: 0))
    strip.reflectScrolledClipView(strip.contentView)
  }
  lastCount = shown.count
}

// The asking (iTerm2 by AppleScript, tmux by a process) takes tens of milliseconds, so it
// runs off the main thread: the main thread only draws, and a swipe never waits on it.
//
// It is asked when something changed, not on a clock: the mod rewrote the shelf (a paste,
// the prompt grew), another app came to the front, tmux's layout or window changed (its
// control mode says so), or a mouse button came up (a window dragged, a tab clicked). A
// check every 20 seconds catches the rest (a tab switched from the keyboard).
let asking = DispatchQueue(label: "image-shelf.place")
var lastPlace: Place?
var isAsking = false
var askAgain = false

func show(_ w: NSWindow) {
  if isForced && forcedWindow != 0 {
    w.level = .normal
    w.order(.above, relativeTo: forcedWindow)
  } else {
    w.level = .floating
    w.orderFrontRegardless()
  }
}

func render() {
  guard let s = shelf, s.visible, !s.items.isEmpty, let p = lastPlace else {
    panel.orderOut(nil)
    patchPanel.orderOut(nil)
    return
  }
  draw(s, p)
  show(panel)
}

func ask() {
  guard let s = shelf, s.visible, !s.items.isEmpty else {
    lastPlace = nil
    return render()
  }
  isForced = FileManager.default.fileExists(atPath: forcePath)
  if isAsking { askAgain = true; return }
  isAsking = true
  screens = NSScreen.screens.map { ($0.frame, Double($0.backingScaleFactor)) }
  let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
  asking.async {
    let p = place(s, front)
    DispatchQueue.main.async {
      lastPlace = p
      render()
      isAsking = false
      if askAgain { askAgain = false; ask() }
    }
  }
}

// Reading the shelf file costs next to nothing, so it is read often.
func readShelf() {
  if getppid() != parent { exit(0) }
  if let owner = try? String(contentsOfFile: pidPath, encoding: .utf8), owner != me { exit(0) }
  guard let text = try? String(contentsOfFile: shelfPath, encoding: .utf8), text != lastText else { return }
  lastText = text
  let read = try? JSONDecoder().decode(Shelf.self, from: Data(text.utf8))
  // A new list of pictures is drawn again; only a moved prompt keeps the drawing.
  if read?.items.map({ "\($0.n):\($0.thumb):\($0.edited)" }) != shelf?.items.map({ "\($0.n):\($0.thumb):\($0.edited)" }) {
    images = [:]
    drawnKey = ""
  }
  let wasTmux = shelf?.tmuxPane ?? ""
  shelf = read
  if let pane = read?.tmuxPane, !pane.isEmpty, pane != wasTmux { watchTmux(pane) }
  ask()
  // The mod writes the shelf as the prompt changes, a moment before Claude Code redraws it;
  // the rule is read again once the redraw has landed.
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { ask() }
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { ask() }
}

// tmux in control mode: a client of our own that prints a line for each change. It takes
// no part in the window's size, gets no pane output, and cannot type.
var control: Process?
func watchTmux(_ pane: String) {
  control?.terminate()
  let name = sh([tmuxPath, "display", "-p", "-t", pane, "#{session_name}"])
  guard !name.isEmpty else { return }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: tmuxPath)
  p.arguments = ["-C", "attach-session", "-t", name, "-f", "ignore-size,no-output,read-only"]
  let input = Pipe(), output = Pipe()
  p.standardInput = input
  p.standardOutput = output
  p.standardError = FileHandle.nullDevice
  var said = ""
  output.fileHandleForReading.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty { handle.readabilityHandler = nil; return }
    said += String(decoding: data, as: UTF8.self)
    var changed = false
    while let end = said.firstIndex(of: "\n") {
      let line = said[..<end]
      said = String(said[said.index(after: end)...])
      if line.hasPrefix("%layout-change") || line.hasPrefix("%window-pane-changed") || line.hasPrefix("%session-window-changed")
        || line.hasPrefix("%window-add") || line.hasPrefix("%window-close") || line.hasPrefix("%unlinked-window") || line.hasPrefix("%client-session-changed") {
        changed = true
      }
    }
    if changed { DispatchQueue.main.async { ask() } }
  }
  do { try p.run() } catch { return }
  control = p
  // Kept so its stdin stays open: control mode ends at end of input.
  controlInput = input
}
var controlInput: Pipe?

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in ask() }
// Global mouse monitoring needs no permission; a drag of the window ends with this.
NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { _ in
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { ask() }
}
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in readShelf() }
Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { _ in ask() }
// While pictures show: the pane's text read twice a second (a few milliseconds, off the
// main thread), and the panel placed again only when the band or the rule moved.
Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
  guard let s = shelf, s.visible, !s.items.isEmpty, lastPlace != nil, !s.tmuxPane.isEmpty, !isAsking else { return }
  let pane = s.tmuxPane
  // lastMarks and lastWidth are written by place(), on this same queue.
  asking.async {
    let was = lastMarks
    let m = marks(pane, lastWidth, MOST_ROWS)
    let now = m.map { "\($0.rule):\($0.collapse.map(String.init) ?? "-"):\($0.tileRows)" } ?? ""
    if now != was { DispatchQueue.main.async { ask() } }
  }
}
readShelf()
atexit { control?.terminate() }
app.run()
