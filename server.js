#!/usr/bin/env node

/**
 * Claude Code Mobile Bridge v5 — Pure tmux
 *
 * Uses tmux capture-pane for output and send-keys for input.
 * No PTY helper, no native modules. Perfect sync guaranteed.
 *
 * Requires: tmux, node
 *
 * Usage:
 *   1. In your IDE terminal:   tmux new -s code && claude
 *   2. In another terminal:    node server.js
 *   3. Open the URL on your phone
 */

var http = require('http');
var os = require('os');
var execSync = require('child_process').execSync;
var exec = require('child_process').exec;

var PORT = parseInt(process.argv[2] || '3391', 10);
var POLL_MS = 150;

// ─── Find binaries ─────────────────────────────────────────

function which(cmd) {
  try { return execSync('which ' + cmd, { encoding: 'utf-8' }).trim(); }
  catch(e) { return null; }
}

var TMUX_BIN = which('tmux');

// ─── State ──────────────────────────────────────────────────

var currentSession = null;
var lastCapture = '';
var pollTimer = null;
var sseClients = [];
var pendingPrompt = false;
var lastChangeTime = 0;
var wasChanging = false;
var prevPromptState = false;
var IDLE_THRESHOLD = 2000; // ms of no change = idle

// ─── Helpers ────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

var PROMPT_PATTERNS = [
  /Allow once/i, /Allow always/i, /Deny/i,
  /do you want to/i, /allow.*\?/i, /proceed\?/i,
  /\(y\/n\)/i, /\[Y\/n\]/i, /\[y\/N\]/i,
];

function looksLikePrompt(text) {
  return PROMPT_PATTERNS.some(function(p) { return p.test(text); });
}

// ─── tmux commands ──────────────────────────────────────────

function tmuxExec(args) {
  try {
    return execSync('tmux ' + args, { encoding: 'utf-8', timeout: 3000 });
  } catch(e) {
    return '';
  }
}

function listSessions() {
  if (!TMUX_BIN) return [];
  try {
    var raw = tmuxExec('list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}"');
    return raw.trim().split('\n').filter(Boolean).map(function(line) {
      var p = line.split('|');
      return { name: p[0], windows: parseInt(p[1])||1, attached: parseInt(p[2])||0, created: parseInt(p[3])||0 };
    });
  } catch(e) { return []; }
}

function capturePane(session) {
  // -e: include escape sequences, -p: to stdout, -t: target session
  return tmuxExec('capture-pane -e -p -t "' + session + '"');
}

function sendKeys(session, keys) {
  // Use -l for literal text (no key name lookup)
  try {
    execSync('tmux send-keys -t "' + session + '" -l ' + escapeShell(keys), { timeout: 2000 });
  } catch(e) {}
}

function sendSpecialKey(session, keyName) {
  // Without -l, tmux interprets key names like Enter, Escape, Up, etc.
  try {
    execSync('tmux send-keys -t "' + session + '" ' + keyName, { timeout: 2000 });
  } catch(e) {}
}

function escapeShell(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function createSession(name, claudeBin) {
  try {
    execSync('tmux new-session -d -s "' + name + '" -x 100 -y 40 "bash -lc \'' + claudeBin + '\'"', { timeout: 5000 });
    return { ok: true, name: name };
  } catch(e) {
    return { ok: false, message: e.message };
  }
}

// ─── Polling ────────────────────────────────────────────────

function startPolling(session) {
  stopPolling();
  currentSession = session;
  lastCapture = '';
  lastChangeTime = Date.now();
  wasChanging = false;
  prevPromptState = false;

  doCapture();
  pollTimer = setInterval(doCapture, POLL_MS);
}

function doCapture() {
  if (!currentSession) return;

  var raw = capturePane(currentSession);
  var now = Date.now();

  if (raw !== lastCapture) {
    // Content changed
    lastCapture = raw;
    lastChangeTime = now;
    wasChanging = true;

    var plain = stripAnsi(raw);
    var newPromptState = looksLikePrompt(plain);

    // Detect prompt appeared
    if (newPromptState && !prevPromptState) {
      broadcast({ type: 'notify', reason: 'prompt', timestamp: now });
    }
    prevPromptState = newPromptState;
    pendingPrompt = newPromptState;

    var html = ansiToHtml(raw);
    broadcast({
      type: 'frame',
      content: html,
      pendingPrompt: pendingPrompt,
      timestamp: now,
    });
  } else if (wasChanging && (now - lastChangeTime) > IDLE_THRESHOLD) {
    // Was changing, now idle for IDLE_THRESHOLD ms → Claude finished
    wasChanging = false;
    broadcast({ type: 'notify', reason: 'idle', timestamp: now });
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  currentSession = null;
  lastCapture = '';
  pendingPrompt = false;
  wasChanging = false;
  prevPromptState = false;
}

// ─── SSE ────────────────────────────────────────────────────

function broadcast(event) {
  var msg = 'data: ' + JSON.stringify(event) + '\n\n';
  sseClients = sseClients.filter(function(res) {
    try { res.write(msg); return true; }
    catch(e) { return false; }
  });
}

// ─── HTTP Server ────────────────────────────────────────────

var server = http.createServer(function(req, res) {
  var url = new URL(req.url, 'http://' + req.headers.host);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Sessions list
  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessions: listSessions(),
      currentSession: currentSession,
      tmuxInstalled: !!TMUX_BIN,
    }));
    return;
  }

  // Attach
  if (url.pathname === '/api/attach' && req.method === 'POST') {
    readBody(req, function(body) {
      var parsed = JSON.parse(body);
      startPolling(parsed.session);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, session: parsed.session }));
    });
    return;
  }

  // Create
  if (url.pathname === '/api/create' && req.method === 'POST') {
    readBody(req, function(body) {
      var parsed = JSON.parse(body);
      var claudeBin;
      try { claudeBin = execSync('bash -lc "which claude"', { encoding: 'utf-8' }).trim(); }
      catch(e) { claudeBin = 'claude'; }
      var result = createSession(parsed.name || ('claude-' + Date.now()), claudeBin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Detach
  if (url.pathname === '/api/detach' && req.method === 'POST') {
    stopPolling();
    broadcast({ type: 'detached' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // SSE stream
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Send current state immediately
    if (currentSession && lastCapture) {
      res.write('data: ' + JSON.stringify({
        type: 'frame',
        content: ansiToHtml(lastCapture),
        pendingPrompt: pendingPrompt,
        session: currentSession,
      }) + '\n\n');
    }
    sseClients.push(res);
    req.on('close', function() { sseClients = sseClients.filter(function(c) { return c !== res; }); });
    return;
  }

  // Send key
  if (url.pathname === '/api/key' && req.method === 'POST') {
    readBody(req, function(body) {
      var parsed = JSON.parse(body);
      if (!currentSession) { res.writeHead(200); res.end('{"ok":false}'); return; }
      // Map to tmux key names
      var specialKeys = {
        'enter': 'Enter', 'escape': 'Escape', 'tab': 'Tab', 'space': 'Space',
        'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
        'backspace': 'BSpace',
        'ctrl-c': 'C-c', 'ctrl-d': 'C-d', 'ctrl-z': 'C-z',
        'ctrl-a': 'C-a', 'ctrl-e': 'C-e', 'ctrl-l': 'C-l',
      };
      if (specialKeys[parsed.key]) {
        sendSpecialKey(currentSession, specialKeys[parsed.key]);
      } else {
        sendKeys(currentSession, parsed.key);
      }
      // Force immediate capture after input
      setTimeout(doCapture, 50);
      setTimeout(doCapture, 200);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // Send text
  if (url.pathname === '/api/input' && req.method === 'POST') {
    readBody(req, function(body) {
      var parsed = JSON.parse(body);
      if (!currentSession || !parsed.text) { res.writeHead(200); res.end('{"ok":false}'); return; }
      // Send each character; if it ends with \r, add Enter
      var text = parsed.text;
      if (text.endsWith('\r') || text.endsWith('\n')) {
        var content = text.slice(0, -1);
        if (content) sendKeys(currentSession, content);
        sendSpecialKey(currentSession, 'Enter');
      } else {
        sendKeys(currentSession, text);
      }
      setTimeout(doCapture, 50);
      setTimeout(doCapture, 200);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // Status
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ currentSession: currentSession, pendingPrompt: pendingPrompt, clients: sseClients.length }));
    return;
  }

  // Serve UI
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(MOBILE_HTML);
});

function readBody(req, cb) {
  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', function() { cb(body); });
}

// ─── ANSI to HTML converter ─────────────────────────────────

function ansiToHtml(str) {
  var colorNames = ['black','red','green','yellow','blue','magenta','cyan','white'];
  var brightColorNames = ['bright-black','bright-red','bright-green','bright-yellow','bright-blue','bright-magenta','bright-cyan','bright-white'];
  var output = '';
  var spans = 0;
  var i = 0;

  // HTML-escape but preserve structure
  str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  while (i < str.length) {
    // ESC [
    if (str.charCodeAt(i) === 27 && str[i+1] === '[') {
      var j = i + 2;
      while (j < str.length && ((str.charCodeAt(j) >= 0x30 && str.charCodeAt(j) <= 0x3F) || str[j] === ';')) j++;
      if (j < str.length) {
        var letter = str[j];
        var params = str.substring(i+2, j);
        if (letter === 'm') {
          var codes = params ? params.split(';') : ['0'];
          var classes = [];
          var ci = 0;
          while (ci < codes.length) {
            var c = parseInt(codes[ci]) || 0;
            if (c === 0) {
              while (spans > 0) { output += '</span>'; spans--; }
              ci++; continue;
            }
            if (c === 1) classes.push('ab');
            else if (c === 2) classes.push('ad');
            else if (c === 3) classes.push('ai');
            else if (c === 4) classes.push('au');
            else if (c >= 30 && c <= 37) classes.push('f' + (c-30));
            else if (c >= 40 && c <= 47) classes.push('b' + (c-40));
            else if (c >= 90 && c <= 97) classes.push('f' + (c-90+8));
            else if (c >= 100 && c <= 107) classes.push('b' + (c-100+8));
            else if (c === 38 && codes[ci+1] === '5') {
              classes.push('f256-' + (codes[ci+2]||0));
              ci += 2;
            } else if (c === 48 && codes[ci+1] === '5') {
              classes.push('b256-' + (codes[ci+2]||0));
              ci += 2;
            }
            ci++;
          }
          if (classes.length) {
            output += '<span class="' + classes.join(' ') + '">';
            spans++;
          }
        }
        i = j + 1; continue;
      }
    }
    // Other ESC sequences — skip
    if (str.charCodeAt(i) === 27) {
      var k = i + 1;
      if (str[k] === ']') {
        while (k < str.length && str.charCodeAt(k) !== 7 && !(str[k] === '\\' && str.charCodeAt(k-1) === 27)) k++;
        i = k + 1; continue;
      }
      i += 2; continue;
    }
    output += str[i]; i++;
  }
  while (spans > 0) { output += '</span>'; spans--; }
  return output;
}

// ─── Mobile HTML ────────────────────────────────────────────

var MOBILE_HTML = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">',
'<meta name="apple-mobile-web-app-capable" content="yes">',
'<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
'<meta name="theme-color" content="#0a0a10">',
'<title>Claude Code Remote</title>',
'<link rel="preconnect" href="https://fonts.googleapis.com">',
'<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">',
'<style>',
':root {',
'  --bg: #0a0a10; --surface: #101018; --surface2: #17171f; --surface3: #1f1f2b;',
'  --border: #262638; --text: #e0e0ec; --text2: #6e6e88; --text3: #44445a;',
'  --orange: #e8864a; --og: rgba(232,134,74,0.12);',
'  --green: #3dd68c; --gg: rgba(61,214,140,0.10);',
'  --red: #e85454; --rg: rgba(232,84,84,0.10);',
'  --amber: #d4a030;',
'  --st: env(safe-area-inset-top,0px); --sb: env(safe-area-inset-bottom,0px);',
'}',
'body.light {',
'  --bg: #f5f5f7; --surface: #ffffff; --surface2: #eeeef2; --surface3: #e4e4ea;',
'  --border: #d4d4dc; --text: #1a1a2e; --text2: #6b6b80; --text3: #9b9bb0;',
'  --orange: #d47030; --og: rgba(212,112,48,0.10);',
'  --green: #1a9960; --gg: rgba(26,153,96,0.10);',
'  --red: #cc3333; --rg: rgba(204,51,51,0.08);',
'  --amber: #b08820;',
'}',
'*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'body{font-family:"Outfit",sans-serif;background:var(--bg);color:var(--text);height:100dvh;display:flex;flex-direction:column;overflow:hidden;padding-top:var(--st)}',
'',
'/* Header */',
'.hdr{flex-shrink:0;background:var(--surface);border-bottom:1px solid var(--border);padding:8px 12px;display:flex;align-items:center;justify-content:space-between}',
'.hdr-l{display:flex;align-items:center;gap:8px}',
'.logo{width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,var(--orange),#c05a2e);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}',
'.hdr-t{font-weight:700;font-size:14px;letter-spacing:-.3px}',
'.hdr-t span{color:var(--text2);font-weight:400}',
'.pill{display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:18px;padding:3px 10px 3px 7px;font-size:11px;font-weight:500;color:var(--text2);cursor:pointer}',
'.dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 5px var(--green)}',
'.dot.off{background:var(--text3);box-shadow:none}',
'.dot.wait{background:var(--amber);box-shadow:0 0 5px var(--amber);animation:bl 1s ease infinite}',
'@keyframes bl{50%{opacity:.3}}',
'',
'/* Session Picker */',
'.sp{display:none;flex-direction:column;flex:1;overflow-y:auto;padding:20px 16px;-webkit-overflow-scrolling:touch}',
'.sp.on{display:flex}',
'.sp h2{font-size:20px;font-weight:800;letter-spacing:-.4px;margin-bottom:4px}',
'.sp .sub{font-size:13px;color:var(--text2);margin-bottom:18px;line-height:1.5}',
'.sp .sec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin:8px 0 8px}',
'.sc{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:11px}',
'.sc:active{transform:scale(.98);background:var(--surface2)}',
'.sc-i{width:34px;height:34px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:15px;background:var(--surface2);border:1px solid var(--border)}',
'.sc-info{flex:1;min-width:0}',
'.sc-n{font-weight:700;font-size:13px}',
'.sc-m{font-size:11px;color:var(--text2);margin-top:1px}',
'.sc-arr{color:var(--text3);font-size:16px}',
'.cc{background:var(--surface);border:1.5px dashed var(--border);border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:11px}',
'.cc:active{transform:scale(.98);border-color:var(--orange)}',
'.cc-i{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--orange);background:var(--og)}',
'.rbtn{display:block;margin:14px auto 0;padding:9px 22px;border-radius:9px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-size:12px;font-weight:600;font-family:"Outfit",sans-serif;cursor:pointer}',
'.no-tmux{background:var(--rg);border:1px solid rgba(232,84,84,.2);border-radius:12px;padding:14px;margin-bottom:14px;font-size:12px;line-height:1.6}',
'.no-tmux code{background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px}',
'.empty{text-align:center;padding:24px 20px;color:var(--text2);font-size:13px;line-height:1.6}',
'.empty code{background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px}',
'',
'/* Terminal */',
'.tv{display:none;flex-direction:column;flex:1;overflow:hidden}',
'.tv.on{display:flex}',
'.tw{flex:1;overflow:hidden;position:relative}',
'.term{height:100%;overflow-y:auto;overflow-x:auto;padding:6px 8px;font-family:"IBM Plex Mono","Menlo",monospace;font-size:10.5px;line-height:1.4;white-space:pre;-webkit-overflow-scrolling:touch;background:var(--bg)}',
'.term::-webkit-scrollbar{width:3px}',
'.term::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}',
'',
'/* ANSI classes */',
'.ab{font-weight:700}.ad{opacity:.6}.ai{font-style:italic}.au{text-decoration:underline}',
'.f0{color:#555}.f1{color:#e85454}.f2{color:#3dd68c}.f3{color:#d4a030}',
'.f4{color:#5a9cf5}.f5{color:#c87aff}.f6{color:#2dd4bf}.f7{color:#dddde8}',
'.f8{color:#666}.f9{color:#ff7b7b}.f10{color:#5eeea6}.f11{color:#f0c050}',
'.f12{color:#7ab8ff}.f13{color:#dda0ff}.f14{color:#55eedd}.f15{color:#fff}',
'.b0{background:rgba(0,0,0,.3)}.b1{background:rgba(232,84,84,.2)}.b2{background:rgba(61,214,140,.15)}',
'.b3{background:rgba(212,160,48,.15)}.b4{background:rgba(90,156,245,.15)}.b5{background:rgba(200,122,255,.15)}',
'.b6{background:rgba(45,212,191,.15)}.b7{background:rgba(255,255,255,.1)}',
'',
'/* Light mode ANSI overrides */',
'body.light .f0{color:#666} body.light .f1{color:#cc3333} body.light .f2{color:#1a8a50} body.light .f3{color:#8a6d00}',
'body.light .f4{color:#2a6fd6} body.light .f5{color:#8a3dbd} body.light .f6{color:#0e7a6a} body.light .f7{color:#1a1a2e}',
'body.light .f8{color:#888} body.light .f9{color:#e04040} body.light .f10{color:#20a060} body.light .f11{color:#a08000}',
'body.light .f12{color:#4488ee} body.light .f13{color:#a050dd} body.light .f14{color:#10a090} body.light .f15{color:#000}',
'body.light .b1{background:rgba(204,51,51,.1)} body.light .b2{background:rgba(26,138,80,.1)}',
'body.light .b3{background:rgba(138,109,0,.1)} body.light .b4{background:rgba(42,111,214,.1)}',
'',
'/* Theme toggle */',
'.theme-btn{width:26px;height:26px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;transition:all .15s;flex-shrink:0;-webkit-user-select:none;user-select:none}',
'.theme-btn:active{transform:scale(.9)}',
'',
'/* Prompt alert */',
'.pa{position:absolute;top:0;left:0;right:0;z-index:10;background:linear-gradient(180deg,var(--og),transparent);border-bottom:1px solid rgba(232,134,74,.2);padding:6px 12px;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--orange);transform:translateY(-100%);transition:transform .3s ease;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}',
'.pa.show{transform:translateY(0)}',
'.pa .bi{animation:bl .8s ease infinite;font-size:14px}',
'',
'/* Controls */',
'.ctrl{flex-shrink:0;background:var(--surface);border-top:1px solid var(--border);padding:6px 8px calc(6px + var(--sb))}',
'',
'/* Row 1: arrows + enter/esc */',
'.r1{display:flex;gap:5px;margin-bottom:5px}',
'.arrows{display:flex;gap:3px;flex-shrink:0}',
'.ak{width:38px;height:38px;border-radius:8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-size:14px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .1s;-webkit-user-select:none;user-select:none}',
'.ak:active{transform:scale(.88);background:var(--surface3)}',
'.r1-right{display:flex;gap:4px;flex:1}',
'.btn-enter{flex:1;height:38px;border-radius:8px;background:var(--gg);border:1.5px solid rgba(61,214,140,.25);color:var(--green);font-family:"Outfit",sans-serif;font-size:13px;font-weight:700;cursor:pointer;transition:all .12s;display:flex;align-items:center;justify-content:center;gap:4px}',
'.btn-enter:active{transform:scale(.95)}',
'.btn-esc{width:46px;height:38px;border-radius:8px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-family:"Outfit",sans-serif;font-size:11px;font-weight:600;cursor:pointer;transition:all .12s;display:flex;align-items:center;justify-content:center}',
'.btn-esc:active{transform:scale(.95)}',
'',
'/* Row 2: quick key grid — wraps, no scroll */',
'.r2{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}',
'.qk{padding:6px 10px;border-radius:7px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-size:11px;font-weight:600;font-family:"Outfit",sans-serif;cursor:pointer;transition:all .1s;-webkit-user-select:none;user-select:none}',
'.qk:active{transform:scale(.92);background:var(--surface3)}',
'.qk.dng{color:var(--red);border-color:rgba(232,84,84,.2)}',
'.qk.bk{color:var(--orange);border-color:rgba(232,134,74,.2)}',
'',
'/* Row 3: input */',
'.r3{display:flex;gap:5px}',
'.ti{flex:1;padding:8px 10px;border-radius:8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-size:13px;font-family:"IBM Plex Mono",monospace;outline:none}',
'.ti:focus{border-color:var(--orange)}',
'.ti::placeholder{color:var(--text3)}',
'.sb{padding:8px 14px;border-radius:8px;border:none;background:var(--orange);color:#fff;font-family:"Outfit",sans-serif;font-size:12px;font-weight:700;cursor:pointer}',
'.sb:active{transform:scale(.94)}',
'</style>',
'</head>',
'<body>',
'',
'<div class="hdr">',
'  <div class="hdr-l">',
'    <div class="logo">CC</div>',
'    <div class="hdr-t">Claude Code <span>Remote</span></div>',
'  </div>',
'  <div style="display:flex;align-items:center;gap:6px">',
'    <div class="theme-btn" id="notifBtn" onclick="toggleNotif()" title="Toggle notifications">&#128276;</div>',
'    <div class="theme-btn" id="themeBtn" onclick="toggleTheme()">&#9789;</div>',
'    <div class="pill" id="pill" onclick="showSessions()">',
'      <div class="dot off" id="dot"></div>',
'      <span id="lbl">pick session</span>',
'    </div>',
'  </div>',
'</div>',
'',
'<div class="sp on" id="sp">',
'  <h2>Sessions</h2>',
'  <div class="sub">Pick a tmux session to mirror on this device.<br>You and your IDE terminal share the same view.</div>',
'  <div id="ntm"></div>',
'  <div class="sec">Active Sessions</div>',
'  <div id="sl"></div>',
'  <div class="sec">New</div>',
'  <div class="cc" onclick="createSes()">',
'    <div class="cc-i">+</div>',
'    <div class="sc-info"><div class="sc-n">New Claude Code session</div><div class="sc-m">Creates a tmux session running claude</div></div>',
'  </div>',
'  <button class="rbtn" onclick="loadSes()">&#10227; Refresh</button>',
'</div>',
'',
'<div class="tv" id="tv">',
'  <div class="tw">',
'    <div class="pa" id="pa"><span class="bi">&#9679;</span><span>Action needed &mdash; use &#9650;&#9660; arrows + Enter</span></div>',
'    <div class="term" id="term"></div>',
'  </div>',
'  <div class="ctrl">',
'    <div class="r1">',
'      <div class="arrows">',
'        <div class="ak" onclick="sk(\'left\')">&#9664;</div>',
'        <div class="ak" onclick="sk(\'up\')">&#9650;</div>',
'        <div class="ak" onclick="sk(\'down\')">&#9660;</div>',
'        <div class="ak" onclick="sk(\'right\')">&#9654;</div>',
'      </div>',
'      <div class="r1-right">',
'        <button class="btn-enter" onclick="sk(\'enter\')">&#8629; Enter</button>',
'        <button class="btn-esc" onclick="sk(\'escape\')">Esc</button>',
'      </div>',
'    </div>',
'    <div class="r2">',
'      <div class="qk" onclick="sk(\'space\')">Space</div>',
'      <div class="qk" onclick="sk(\'tab\')">Tab</div>',
'      <div class="qk" onclick="sk(\'backspace\')">&#9003;</div>',
'      <div class="qk dng" onclick="sk(\'ctrl-c\')">^C</div>',
'      <div class="qk dng" onclick="sk(\'ctrl-z\')">^Z</div>',
'      <div class="qk" onclick="sk(\'ctrl-l\')">^L</div>',
'      <div class="qk bk" onclick="showSessions()">&#9664; Sessions</div>',
'    </div>',
'    <div class="r3">',
'      <input class="ti" id="ti" placeholder="Type here..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">',
'      <button class="sb" onclick="sendT()">Send</button>',
'    </div>',
'  </div>',
'</div>',
'',
'<script>',
'var dot=document.getElementById("dot"),lbl=document.getElementById("lbl"),pa=document.getElementById("pa"),termEl=document.getElementById("term");',
'var es=null,autoScroll=true;',
'',
'// ── Notifications ──',
'var notifEnabled=true;',
'var audioCtx=null;',
'function initAudio(){if(!audioCtx)try{audioCtx=new(window.AudioContext||window.webkitAudioContext)()}catch(e){}}',
'function beep(freq,dur){',
'  initAudio();if(!audioCtx)return;',
'  try{var o=audioCtx.createOscillator(),g=audioCtx.createGain();',
'  o.connect(g);g.connect(audioCtx.destination);',
'  o.type="sine";o.frequency.value=freq;g.gain.value=0.3;',
'  o.start();o.stop(audioCtx.currentTime+dur/1000)}catch(e){}',
'}',
'function notifyUser(title,body,isPrompt){',
'  if(!notifEnabled)return;',
'  // Sound',
'  if(isPrompt){beep(880,120);setTimeout(function(){beep(1100,120)},150)}',
'  else{beep(660,100);setTimeout(function(){beep(880,150)},130)}',
'  // Vibrate',
'  if(navigator.vibrate){isPrompt?navigator.vibrate([100,50,100,50,150]):navigator.vibrate([80,40,80])}',
'  // Native notification (when tab is in background)',
'  if(document.hidden&&"Notification" in window&&Notification.permission==="granted"){',
'    try{new Notification(title,{body:body,icon:"data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23e8864a%22 rx=%2220%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2268%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2250%22 font-weight=%22bold%22>CC</text></svg>",tag:"cc-"+Date.now(),renotify:true})}catch(e){}',
'  }',
'}',
'// Request notification permission on first user interaction',
'function reqNotifPerm(){',
'  if("Notification" in window&&Notification.permission==="default"){',
'    Notification.requestPermission();',
'  }',
'  initAudio();',
'  document.removeEventListener("click",reqNotifPerm);',
'}',
'document.addEventListener("click",reqNotifPerm);',
'',
'termEl.addEventListener("scroll",function(){autoScroll=(termEl.scrollHeight-termEl.scrollTop-termEl.clientHeight)<40});',
'',
'function setS(s,t){dot.className="dot"+(s==="off"?" off":s==="wait"?" wait":"");lbl.textContent=t||(s==="off"?"disconnected":"connected")}',
'function showPA(b){pa.classList.toggle("show",b);if(b)setS("wait")}',
'',
'function showSessions(){',
'  document.getElementById("sp").classList.add("on");',
'  document.getElementById("tv").classList.remove("on");',
'  setS("off","pick session");',
'  if(es){es.close();es=null}',
'  fetch("/api/detach",{method:"POST"});',
'  loadSes();',
'}',
'',
'function showTerm(n){',
'  document.getElementById("sp").classList.remove("on");',
'  document.getElementById("tv").classList.add("on");',
'  setS("on",n);',
'}',
'',
'function loadSes(){',
'  fetch("/api/sessions").then(function(r){return r.json()}).then(function(d){',
'    var sl=document.getElementById("sl"),ntm=document.getElementById("ntm");',
'    if(!d.tmuxInstalled){ntm.innerHTML=\'<div class="no-tmux">tmux not installed. Run: <code>brew install tmux</code></div>\';sl.innerHTML="";return}',
'    ntm.innerHTML="";',
'    if(!d.sessions.length){sl.innerHTML=\'<div class="empty">No sessions found.<br>In your terminal run:<br><code>tmux new -s code</code> then <code>claude</code></div>\';return}',
'    sl.innerHTML=d.sessions.map(function(s){',
'      var a=s.attached>0?" &middot; "+s.attached+" attached":"";',
'      return \'<div class="sc" onclick="attachSes(\\x27\'+s.name+\'\\x27)"><div class="sc-i">&#9638;</div><div class="sc-info"><div class="sc-n">\'+s.name+\'</div><div class="sc-m">\'+s.windows+" win"+a+\'</div></div><div class="sc-arr">&#8250;</div></div>\';',
'    }).join("");',
'  });',
'}',
'',
'function attachSes(n){',
'  showTerm(n);termEl.innerHTML="";',
'  fetch("/api/attach",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session:n})}).then(function(){connectSSE()});',
'}',
'',
'function createSes(){',
'  var n="claude-"+Math.floor(Date.now()/1000);',
'  fetch("/api/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n})}).then(function(r){return r.json()}).then(function(d){',
'    if(d.ok)setTimeout(function(){attachSes(d.name)},600);',
'    else alert("Error: "+d.message);',
'  });',
'}',
'',
'function connectSSE(){',
'  if(es)es.close();',
'  es=new EventSource("/api/stream");',
'  es.onmessage=function(e){',
'    try{',
'      var m=JSON.parse(e.data);',
'      if(m.type==="frame"){',
'        termEl.innerHTML=m.content;',
'        if(autoScroll)requestAnimationFrame(function(){termEl.scrollTop=termEl.scrollHeight});',
'        if(m.pendingPrompt)showPA(true);else showPA(false);',
'      }else if(m.type==="notify"){',
'        if(m.reason==="prompt")notifyUser("Action needed","Claude Code is waiting for your approval",true);',
'        else if(m.reason==="idle")notifyUser("Response complete","Claude Code has finished responding",false);',
'      }else if(m.type==="detached"){setS("off","detached")}',
'    }catch(err){console.error(err)}',
'  };',
'  es.onerror=function(){es.close();setTimeout(connectSSE,3000)};',
'}',
'',
'function sk(k){',
'  fetch("/api/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k})});',
'  showPA(false);if(navigator.vibrate)navigator.vibrate(20);',
'}',
'function sendT(){',
'  var i=document.getElementById("ti"),t=i.value;if(!t)return;',
'  fetch("/api/input",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:t+"\\r"})});',
'  i.value="";showPA(false);if(navigator.vibrate)navigator.vibrate(20);',
'}',
'document.getElementById("ti").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();sendT()}});',
'',
'// ── Theme ──',
'function toggleTheme(){',
'  var isLight=document.body.classList.toggle("light");',
'  document.getElementById("themeBtn").innerHTML=isLight?"&#9728;":"&#9789;";',
'  document.querySelector("meta[name=theme-color]").content=isLight?"#f5f5f7":"#0a0a10";',
'  try{localStorage.setItem("cc-theme",isLight?"light":"dark")}catch(e){}',
'}',
'(function(){try{if(localStorage.getItem("cc-theme")==="light"){document.body.classList.add("light");document.getElementById("themeBtn").innerHTML="&#9728;";document.querySelector("meta[name=theme-color]").content="#f5f5f7"}}catch(e){}}());',
'',
'// ── Notification toggle ──',
'function toggleNotif(){',
'  notifEnabled=!notifEnabled;',
'  document.getElementById("notifBtn").innerHTML=notifEnabled?"&#128276;":"&#128277;";',
'  document.getElementById("notifBtn").style.opacity=notifEnabled?"1":"0.4";',
'  if(notifEnabled){initAudio();reqNotifPerm()}',
'  try{localStorage.setItem("cc-notif",notifEnabled?"on":"off")}catch(e){}',
'}',
'(function(){try{if(localStorage.getItem("cc-notif")==="off"){notifEnabled=false;document.getElementById("notifBtn").innerHTML="&#128277;";document.getElementById("notifBtn").style.opacity="0.4"}}catch(e){}}());',
'',
'loadSes();',
'</script>',
'</body></html>',
].join('\n');

// ─── Startup ────────────────────────────────────────────────

function getLocalIP() {
  var interfaces = os.networkInterfaces();
  var keys = Object.keys(interfaces);
  for (var i = 0; i < keys.length; i++) {
    var ifaces = interfaces[keys[i]];
    for (var j = 0; j < ifaces.length; j++) {
      if (ifaces[j].family === 'IPv4' && !ifaces[j].internal) return ifaces[j].address;
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', function() {
  var ip = getLocalIP();
  var sessions = listSessions();
  console.log('');
  console.log('  ┌──────────────────────────────────────┐');
  console.log('  │   Claude Code Mobile Bridge v5        │');
  console.log('  │   Pure tmux · Perfect sync            │');
  console.log('  └──────────────────────────────────────┘');
  console.log('');
  console.log('  📱  http://' + ip + ':' + PORT);
  console.log('  💻  http://localhost:' + PORT);
  console.log('  🔧  tmux: ' + (TMUX_BIN || 'NOT FOUND — run: brew install tmux'));
  console.log('');
  if (sessions.length) {
    console.log('  Active tmux sessions:');
    sessions.forEach(function(s) {
      console.log('    • ' + s.name + ' (' + s.windows + ' win, ' + s.attached + ' attached)');
    });
  } else {
    console.log('  No tmux sessions. Start one:');
    console.log('    tmux new -s code');
    console.log('    claude');
  }
  console.log('');
});
