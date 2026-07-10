// 手机监工页面：单文件内联 HTML/CSS/JS，零外部依赖，不进 Vite 构建管线。
// 页面是纯只读镜像；所有会话文本一律走 textContent 渲染，绝不 innerHTML
// 插值 agent 输出。页内脚本刻意避免模板字符串，绕开外层 TS 模板的转义。
export const renderRemoteMonitorPage = () => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Chill Vibe 监工</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --run: #d29922; --err: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding-bottom: env(safe-area-inset-bottom);
  }
  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 10px;
    padding: calc(10px + env(safe-area-inset-top)) 14px 10px;
    background: rgba(13,17,23,0.92); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 16px; font-weight: 600; flex: 1; }
  .conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--err); flex: none; }
  .conn-dot.is-on { background: var(--ok); }
  .sound-btn {
    border: 1px solid var(--border); background: var(--panel); color: var(--muted);
    border-radius: 8px; padding: 5px 10px; font-size: 13px;
  }
  .sound-btn.is-on { color: var(--ok); border-color: var(--ok); }
  main { padding: 12px 12px 32px; max-width: 720px; margin: 0 auto; }
  .col-title { color: var(--muted); font-size: 12px; margin: 14px 4px 6px; text-transform: none; }
  .card {
    display: block; width: 100%; text-align: left;
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 12px 14px; margin-bottom: 10px; color: var(--text);
  }
  .card-row { display: flex; align-items: center; gap: 8px; }
  .card-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; border-radius: 999px; padding: 2px 8px; border: 1px solid var(--border); color: var(--muted); flex: none; }
  .badge.is-streaming { color: var(--run); border-color: var(--run); }
  .badge.is-error { color: var(--err); border-color: var(--err); }
  .badge.is-done { color: var(--ok); border-color: var(--ok); }
  .card-meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
  .card-preview { color: var(--muted); font-size: 13px; margin-top: 6px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .back-btn { border: none; background: none; color: var(--accent); font-size: 15px; padding: 8px 0; }
  .detail-title { font-size: 17px; margin: 4px 0 12px; }
  .msg { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  .msg.live { border-color: var(--run); }
  .act { border-left: 3px solid var(--accent); background: var(--panel); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; font-size: 13px; color: var(--muted); word-break: break-word; }
  .act.edits { border-left-color: var(--ok); }
  .edit-file { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .edit-path { flex: 1; word-break: break-all; color: var(--text); }
  .lines-add { color: var(--ok); flex: none; }
  .lines-del { color: var(--err); flex: none; }
  details.patch { margin-top: 4px; }
  details.patch summary { color: var(--accent); font-size: 12px; cursor: pointer; }
  details.patch pre { overflow-x: auto; font-size: 11px; line-height: 1.45; background: #0a0d12; border-radius: 6px; padding: 8px; margin-top: 6px; }
  .empty { color: var(--muted); text-align: center; padding: 48px 0; }
  .notice { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--ok); color: var(--text); border-radius: 10px; padding: 10px 16px; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity .25s; max-width: 90vw; }
  .notice.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <span class="conn-dot" id="connDot"></span>
  <h1 id="headerTitle">Chill Vibe 监工</h1>
  <button class="sound-btn" id="soundBtn" type="button">🔕 提醒</button>
</header>
<main id="listView"><div class="empty">加载中…</div></main>
<main id="detailView" hidden>
  <button class="back-btn" id="backBtn" type="button">‹ 返回列表</button>
  <h2 class="detail-title" id="detailTitle"></h2>
  <div id="detailBody"></div>
</main>
<div class="notice" id="notice"></div>
<script>
(function () {
  'use strict'
  var token = new URLSearchParams(location.search).get('token') || ''
  var listView = document.getElementById('listView')
  var detailView = document.getElementById('detailView')
  var detailTitle = document.getElementById('detailTitle')
  var detailBody = document.getElementById('detailBody')
  var connDot = document.getElementById('connDot')
  var noticeEl = document.getElementById('notice')
  var soundBtn = document.getElementById('soundBtn')
  var baseTitle = document.title

  // streamId -> { cardId, liveText, items: [{type,id}], texts: Map, acts: Map, state }
  var streams = new Map()
  var cardsById = new Map()
  var columns = []
  var selectedStreamId = null
  var doneCount = 0
  var notifiedStreams = new Set()
  var audioCtx = null
  var soundEnabled = false
  var snapshotTimer = null

  soundBtn.addEventListener('click', function () {
    soundEnabled = !soundEnabled
    if (soundEnabled && !audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch (e) {}
    }
    if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume() }
    soundBtn.textContent = soundEnabled ? '🔔 提醒' : '🔕 提醒'
    soundBtn.classList.toggle('is-on', soundEnabled)
    if (soundEnabled && 'Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission() } catch (e) {}
    }
  })

  function beep() {
    if (!soundEnabled || !audioCtx) { return }
    try {
      var osc = audioCtx.createOscillator()
      var gain = audioCtx.createGain()
      osc.connect(gain); gain.connect(audioCtx.destination)
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6)
      osc.start(); osc.stop(audioCtx.currentTime + 0.6)
    } catch (e) {}
  }

  function showNotice(text) {
    noticeEl.textContent = text
    noticeEl.classList.add('show')
    setTimeout(function () { noticeEl.classList.remove('show') }, 4000)
  }

  function notifyFinished(streamId, isError) {
    if (notifiedStreams.has(streamId)) { return }
    notifiedStreams.add(streamId)
    doneCount += 1
    document.title = (isError ? '❌ ' : '✅ ') + doneCount + ' 个跑完 · ' + baseTitle
    var info = streams.get(streamId)
    var card = info && info.cardId ? cardsById.get(info.cardId) : null
    var name = card ? card.title : '会话'
    var text = isError ? (name + ' 出错了') : (name + ' 跑完了')
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]) } catch (e) {} }
    beep()
    showNotice(text)
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Chill Vibe 监工', { body: text }) } catch (e) {}
    }
  }

  function getStream(streamId, cardId) {
    var entry = streams.get(streamId)
    if (!entry) {
      entry = { cardId: cardId, liveText: '', items: [], texts: new Map(), acts: new Map(), state: 'streaming' }
      streams.set(streamId, entry)
      scheduleSnapshot()
    }
    if (cardId && !entry.cardId) { entry.cardId = cardId }
    return entry
  }

  function handleStreamEvent(payload) {
    var entry = getStream(payload.streamId, payload.cardId)
    var kind = payload.event
    var data = payload.data || {}

    if (kind === 'delta') {
      entry.liveText += (data.content || '')
    } else if (kind === 'assistant_message') {
      if (!entry.texts.has(data.itemId)) { entry.items.push({ type: 'text', id: data.itemId }) }
      entry.texts.set(data.itemId, data.content || '')
      entry.liveText = ''
    } else if (kind === 'activity') {
      if (!entry.acts.has(data.itemId)) { entry.items.push({ type: 'act', id: data.itemId }) }
      entry.acts.set(data.itemId, data)
    } else if (kind === 'done') {
      entry.state = data && data.stopped ? 'stopped' : 'done'
      notifyFinished(payload.streamId, false)
      scheduleSnapshot()
    } else if (kind === 'error') {
      entry.state = 'error'
      notifyFinished(payload.streamId, true)
      scheduleSnapshot()
    }

    if (selectedStreamId === payload.streamId) { renderDetail() }
    else if (kind === 'done' || kind === 'error') { renderList() }
  }

  function findStreamForCard(card) {
    if (card.streamId && streams.has(card.streamId)) { return card.streamId }
    var found = null
    streams.forEach(function (entry, id) { if (entry.cardId === card.id) { found = id } })
    return found || card.streamId || null
  }

  function statusOfCard(card) {
    var sid = findStreamForCard(card)
    if (sid && streams.has(sid)) {
      var st = streams.get(sid).state
      if (st === 'streaming') { return 'streaming' }
      if (st === 'error') { return 'error' }
      return 'done'
    }
    return card.status
  }

  function renderList() {
    listView.textContent = ''
    var hasAny = false
    columns.forEach(function (column) {
      if (!column.cards.length) { return }
      hasAny = true
      var colTitle = document.createElement('div')
      colTitle.className = 'col-title'
      colTitle.textContent = column.title
      listView.appendChild(colTitle)
      column.cards.forEach(function (card) {
        cardsById.set(card.id, card)
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'card'
        var row = document.createElement('div')
        row.className = 'card-row'
        var title = document.createElement('span')
        title.className = 'card-title'
        title.textContent = card.title
        var badge = document.createElement('span')
        var status = statusOfCard(card)
        badge.className = 'badge is-' + status
        badge.textContent = status === 'streaming' ? '运行中' : status === 'error' ? '出错' : status === 'done' ? '已完成' : '空闲'
        row.appendChild(title); row.appendChild(badge)
        var meta = document.createElement('div')
        meta.className = 'card-meta'
        meta.textContent = card.provider + (card.model ? ' · ' + card.model : '')
        btn.appendChild(row); btn.appendChild(meta)
        if (card.lastMessagePreview) {
          var preview = document.createElement('div')
          preview.className = 'card-preview'
          preview.textContent = card.lastMessagePreview
          btn.appendChild(preview)
        }
        btn.addEventListener('click', function () { openDetail(card) })
        listView.appendChild(btn)
      })
    })
    if (!hasAny) {
      var empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有会话卡片'
      listView.appendChild(empty)
    }
  }

  function openDetail(card) {
    selectedStreamId = findStreamForCard(card)
    detailTitle.textContent = card.title
    listView.hidden = true
    detailView.hidden = false
    renderDetail()
    window.scrollTo(0, 0)
  }

  document.getElementById('backBtn').addEventListener('click', function () {
    selectedStreamId = null
    detailView.hidden = true
    listView.hidden = false
    renderList()
  })

  function renderActivity(container, act) {
    var box = document.createElement('div')
    box.className = 'act' + (act.kind === 'edits' ? ' edits' : '')
    if (act.kind === 'edits' && act.files) {
      var head = document.createElement('div')
      head.textContent = '📝 改动 ' + act.files.length + ' 个文件'
      box.appendChild(head)
      act.files.forEach(function (file) {
        var rowEl = document.createElement('div')
        rowEl.className = 'edit-file'
        var pathEl = document.createElement('span')
        pathEl.className = 'edit-path'
        pathEl.textContent = file.path
        var addEl = document.createElement('span')
        addEl.className = 'lines-add'
        addEl.textContent = '+' + (file.addedLines || 0)
        var delEl = document.createElement('span')
        delEl.className = 'lines-del'
        delEl.textContent = '-' + (file.removedLines || 0)
        rowEl.appendChild(pathEl); rowEl.appendChild(addEl); rowEl.appendChild(delEl)
        box.appendChild(rowEl)
        if (file.patch) {
          var det = document.createElement('details')
          det.className = 'patch'
          var sum = document.createElement('summary')
          sum.textContent = '查看 patch'
          var pre = document.createElement('pre')
          pre.textContent = file.patch
          det.appendChild(sum); det.appendChild(pre)
          box.appendChild(det)
        }
      })
    } else if (act.kind === 'command') {
      box.textContent = '💻 ' + (act.command || '') + (act.status === 'in_progress' ? ' · 运行中' : '')
    } else if (act.kind === 'reasoning') {
      var detR = document.createElement('details')
      var sumR = document.createElement('summary')
      sumR.textContent = '🧠 思考过程'
      var preR = document.createElement('div')
      preR.style.whiteSpace = 'pre-wrap'
      preR.textContent = act.content || act.summary || ''
      detR.appendChild(sumR); detR.appendChild(preR)
      box.appendChild(detR)
    } else {
      box.textContent = '⚙️ ' + (act.kind || 'activity')
    }
    container.appendChild(box)
  }

  function renderDetail() {
    detailBody.textContent = ''
    if (!selectedStreamId || !streams.has(selectedStreamId)) {
      var emptyEl = document.createElement('div')
      emptyEl.className = 'empty'
      emptyEl.textContent = '这张卡当前没有活跃输出（可能已跑完或还没开始）'
      detailBody.appendChild(emptyEl)
      return
    }
    var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120
    var entry = streams.get(selectedStreamId)
    entry.items.forEach(function (item) {
      if (item.type === 'text') {
        var msg = document.createElement('div')
        msg.className = 'msg'
        msg.textContent = entry.texts.get(item.id) || ''
        detailBody.appendChild(msg)
      } else {
        renderActivity(detailBody, entry.acts.get(item.id) || {})
      }
    })
    if (entry.liveText) {
      var live = document.createElement('div')
      live.className = 'msg live'
      live.textContent = entry.liveText
      detailBody.appendChild(live)
    }
    if (entry.state !== 'streaming') {
      var doneEl = document.createElement('div')
      doneEl.className = 'act'
      doneEl.textContent = entry.state === 'error' ? '❌ 本轮出错结束' : '✅ 本轮已完成'
      detailBody.appendChild(doneEl)
    }
    if (nearBottom) { window.scrollTo(0, document.body.scrollHeight) }
  }

  function loadSnapshot() {
    return fetch('/api/snapshot?token=' + encodeURIComponent(token))
      .then(function (response) { return response.json() })
      .then(function (snapshot) {
        columns = snapshot.columns || []
        columns.forEach(function (column) {
          column.cards.forEach(function (card) { cardsById.set(card.id, card) })
        })
        if (!selectedStreamId) { renderList() }
      })
      .catch(function () {})
  }

  function scheduleSnapshot() {
    if (snapshotTimer) { return }
    snapshotTimer = setTimeout(function () {
      snapshotTimer = null
      loadSnapshot()
    }, 1500)
  }

  function connect() {
    var source = new EventSource('/api/events?token=' + encodeURIComponent(token))
    source.addEventListener('stream', function (event) {
      try { handleStreamEvent(JSON.parse(event.data)) } catch (e) {}
    })
    source.onopen = function () { connDot.classList.add('is-on') }
    source.onerror = function () { connDot.classList.remove('is-on') }
  }

  loadSnapshot()
  connect()
})()
</script>
</body>
</html>
`
