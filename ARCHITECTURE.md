# image-shelf 怎麼運作 / Architecture

## 兩個部分

| 部分 | 檔案 | 語言 | 跨平台？ |
|---|---|---|---|
| mod 本體 | `hooks/register.tsx` | TypeScript（Claude Code mod API） | API 跨平台，但目前呼叫了 macOS 指令（見下） |
| 浮動視窗 | `panel/shelf.swift` | Swift / AppKit | 只有 macOS |
| 標註編輯器 | `editor/editor.swift` + `editor.html` | Swift + WebKit，取自 paste-preview | 只有 macOS（paste-preview 有瀏覽器版 `server.mjs` 可參考） |

## 一次貼圖的流程

1. Claude Code 把貼上的圖存到 `<tmp>/claude-<uid>/<project>/<session>/images/<N>.png`，輸入框出現 `[Image #N]`。這是 Claude Code 的內部結構，不是公開 API。
2. mod 監看輸入框（`prompt.edit` 加上每 0.7 秒檢查），發現新的 N 就把圖複製到自己的資料夾，做一張 480px 縮圖。
3. 兩種畫法：
   - **終端機會畫圖**（Ghostty、kitty、WezTerm，且不在 tmux 裡）：mod 在 `AbovePrompt` 區塊直接用 Claude Code 的 `Image` 元件畫。
   - **終端機不會畫圖**（iTerm2、tmux）：mod 在 `AbovePrompt` 留 4 列空白，把圖片清單寫進 `shelf.json`；浮動視窗讀它，找到那些空白列在螢幕上的位置，把圖蓋上去。
4. 點圖片 → 標註編輯器寫回複本 → mod 看到檔案時間變了，標成已編輯 → 送出時在 `prompt.submit` 加一句 context 叫 Claude 讀編輯版。

## 浮動視窗怎麼找位置（最難的部分）

- iTerm2（AppleScript）：前景視窗的位置、大小、分頁數、目前 session 的 tty
- tmux：client 的字格像素大小、窗格的列與欄位置
- tmux `capture-pane`：在畫面文字裡找輸入框上方的 `───` 白線和 Claude Code 的 `[-]`
- 列從視窗頂端往下多少點開始，依視窗樣式不同（標題列、分頁列）：截一條 40pt 寬的細長畫面，找兩條白線反推，依視窗形狀快取
- 何時重算：mod 改寫 `shelf.json`、切換 App（NSWorkspace 通知）、tmux 版面變動（tmux control mode）、滑鼠放開、每 0.5 秒看白線有沒有移動、每 20 秒保險

## macOS 專屬的地方（移植時要換掉的）

| 用途 | 現在用的 | 位置 |
|---|---|---|
| 讀圖片尺寸、做縮圖、轉 PNG | `sips` | `register.tsx` `look()`、`capture()` |
| 暫存資料夾 | `/private/tmp/...` | `register.tsx` `setUp()`、`build()` |
| 編譯浮動視窗與編輯器 | `xcrun swiftc` | `register.tsx` `build()` |
| 沒有編輯器時的退路 | `open -a Preview` | `register.tsx` `open()` |
| 整個浮動視窗 | AppKit、AppleScript、`screencapture` | `panel/shelf.swift` |

## 移植的建議順序

1. **Windows/Linux + WezTerm（最簡單）**：WezTerm 會畫圖，走第 3 步的第一種畫法，不需要浮動視窗。只要把 `sips` 換成跨平台的做法（例如讀 PNG 檔頭拿尺寸、讓終端機自己縮放，paste-preview 的 `hooks/platform.ts` 就是這樣做的）、暫存路徑改用 `TMPDIR`/`%TEMP%`、編輯器改用瀏覽器版。
2. **Windows Terminal**：它不支援畫圖，要另做一個浮動視窗（例如 C# 或 PowerShell + WinForms），用 Win32 API 找視窗位置。
3. **Linux 上的其他終端機**：同上，X11/Wayland 各自不同。

---

**English summary**: the mod (`hooks/register.tsx`) watches the prompt for `[Image #N]`, copies Claude Code's paste, and either draws it with Claude Code's `Image` element (terminals with the kitty graphics protocol, outside tmux) or reserves blank rows and lets a floating AppKit window (`panel/shelf.swift`) cover them, locating the rows via iTerm2 AppleScript, tmux, the prompt's rules read from `capture-pane`, and a one-off screen measurement. macOS-only pieces are listed in the table above; the easiest port is WezTerm on Windows/Linux, which needs no floating window.
