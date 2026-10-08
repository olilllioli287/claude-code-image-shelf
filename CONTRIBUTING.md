# 一起開發 image-shelf / Contributing

**繁體中文** | [English](#english)

歡迎！這個專案目前只支援 macOS，最需要的就是 **Windows 和 Linux 的支援**。不用一次做完，修一個小 bug、在你的環境測試回報，都很有幫助。

## 先看懂它怎麼運作

看 [ARCHITECTURE.md](ARCHITECTURE.md)，十分鐘內能讀完。重點：mod 本體（TypeScript，跨平台）負責「知道貼了什麼、讓出位置」；畫圖的方式依終端機而定。

## 在本機開發

```sh
git clone https://github.com/olilllioli287/claude-code-image-shelf
cd claude-code-image-shelf
claude --plugin-dir .            # 用這個資料夾的版本啟動 Claude Code
claude plugin validate .         # 檢查 mod 會不會被拒絕載入
claude plugin test .             # 跑 hooks/*.test.tsx
```

改了 `hooks/` 裡的程式，在 Claude Code 裡打 `/reload-plugins` 就會重新載入。改了 `panel/shelf.swift`，舊的浮動視窗會在 mod 重新載入時被關掉，下次貼圖自動重新編譯。

除錯：在 `/private/tmp/image-shelf/<session 前 8 碼>/` 建一個空檔 `debug.on`，浮動視窗會把每次的定位結果寫進 `debug.txt`。

## 想做什麼，先開 issue

先看 [issues](https://github.com/olilllioli287/claude-code-image-shelf/issues)，有 `help wanted` 標籤的是特別需要人手的。想做的事沒有 issue 的話，先開一個說你打算怎麼做，避免白工。

## 送 PR

- 一個 PR 做一件事
- 說明在什麼環境測過（作業系統、終端機、有沒有 tmux），附截圖或錄影最好
- 不要破壞 macOS 現有的行為；改到共用的地方，請說明怎麼確認沒壞
- 新的平台程式放自己的檔案，例如 `panel/windows/`，共用的判斷放 `hooks/`

---

## English

Welcome! image-shelf runs on macOS only today, and **Windows and Linux support** is what it needs most. Small fixes and test reports from your setup help too.

1. Read [ARCHITECTURE.md](ARCHITECTURE.md).
2. Develop with `claude --plugin-dir .`, check with `claude plugin validate .` and `claude plugin test .`; `/reload-plugins` reloads after an edit.
3. Look for `help wanted` issues, or open one describing your plan before a large change.
4. PRs: one change each, say where you tested (OS, terminal, tmux or not), keep macOS working, put platform code in its own files.
