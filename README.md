# Claude Code Mobile Bridge v5

Mirror and control your Claude Code terminal **from your phone**. Perfect sync with your IDE — both see the exact same thing.

## Quick Start

```bash
# 1. Install tmux (one time)
brew install tmux

# 2. Start Claude Code in tmux (in your IDE terminal)
tmux new -s code
claude

# 3. Run the bridge (in another terminal tab)
node server.js

# 4. Open the printed URL on your phone
```

## What Changed in v5

Completely rewritten. No more PTY helper, no xterm.js, no sync bugs.

- **Output:** polls `tmux capture-pane` every 150ms → always shows the real screen state
- **Input:** uses `tmux send-keys` → goes directly to the pane, works from both sides
- **Result:** phone and IDE terminal are always perfectly in sync

## Controls

| Button | Action |
|--------|--------|
| ✓ Accept / ✕ Reject | Sends `y` / `n` |
| Arrow pad (▲▼◀▶) | Navigate Claude Code menus |
| Enter / Esc / Space / Tab | Common keys |
| ⌫ Backspace | Delete |
| ^C / ^Z / ^L | Ctrl shortcuts |
| Text input + Send | Type and send anything |

## Requirements

- **tmux** — `brew install tmux`
- **Node.js** (any version)
- **Claude Code CLI** (`claude` command)
- Same WiFi network
