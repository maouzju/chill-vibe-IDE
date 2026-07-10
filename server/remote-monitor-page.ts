// 手机监工页面：单文件内联 HTML/CSS/JS，零外部依赖，不进 Vite 构建管线。
// V2 起可互动：发需求 / 停止 / 新建会话 / 调模型档位，全部 POST /api/actions
// 由渲染进程复用电脑端 handler 执行。所有会话文本一律走 textContent 渲染，
// 绝不 innerHTML 插值 agent 输出。页内脚本刻意避免模板字符串，绕开外层
// TS 模板的转义。
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
  main#detailView { padding-bottom: 150px; }
  .col-head { display: flex; align-items: center; gap: 8px; margin: 14px 4px 6px; }
  .col-title { color: var(--muted); font-size: 12px; flex: 1; }
  .col-add {
    border: 1px solid var(--border); background: var(--panel); color: var(--accent);
    border-radius: 999px; padding: 2px 10px; font-size: 12px;
  }
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
  .detail-title { font-size: 17px; margin: 4px 0 8px; }
  .picker-row { display: flex; gap: 8px; margin-bottom: 12px; }
  .picker-row select {
    flex: 1; min-width: 0;
    background: var(--panel); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px;
    padding: 7px 8px; font-size: 13px;
  }
  .msg { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  .msg.live { border-color: var(--run); }
  .act { border-left: 3px solid var(--accent); background: var(--panel); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; font-size: 13px; color: var(--muted); word-break: break-word; }
  .act.edits { border-left-color: var(--ok); }
  .act.ask { border-left-color: var(--run); color: var(--text); }
  .act-line { padding: 1px 0; }
  .tool-input { font-family: ui-monospace, Consolas, monospace; font-size: 12px; padding: 1px 0; word-break: break-all; }
  .edit-file { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .edit-path { flex: 1; word-break: break-all; color: var(--text); }
  .lines-add { color: var(--ok); flex: none; }
  .lines-del { color: var(--err); flex: none; }
  details.patch { margin-top: 4px; }
  details.patch summary { color: var(--accent); font-size: 12px; cursor: pointer; }
  details.patch pre { overflow-x: auto; font-size: 11px; line-height: 1.45; background: #0a0d12; border-radius: 6px; padding: 8px; margin-top: 6px; }
  .empty { color: var(--muted); text-align: center; padding: 48px 0; }
  .composer {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    background: rgba(13,17,23,0.96); backdrop-filter: blur(8px);
    border-top: 1px solid var(--border);
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  }
  .composer-inner { max-width: 720px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea {
    flex: 1; min-height: 42px; max-height: 120px; resize: none;
    background: var(--panel); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; font: inherit; font-size: 14px;
  }
  .composer textarea:focus { outline: none; border-color: var(--accent); }
  .send-btn, .stop-btn {
    flex: none; border: none; border-radius: 10px;
    padding: 10px 16px; font-size: 14px; font-weight: 600;
  }
  .send-btn { background: var(--accent); color: #08131f; }
  .send-btn:disabled { opacity: 0.45; }
  .stop-btn { background: transparent; color: var(--err); border: 1px solid var(--err); }
  .notice { position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--ok); color: var(--text); border-radius: 10px; padding: 10px 16px; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity .25s; max-width: 90vw; z-index: 30; }
  .notice.show { opacity: 1; }
  .notice.is-error { border-color: var(--err); }
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
  <div class="picker-row">
    <select id="modelSelect" aria-label="模型"></select>
    <select id="effortSelect" aria-label="推理档位"></select>
  </div>
  <div id="detailBody"></div>
</main>
<div class="composer" id="composer" hidden>
  <div class="composer-inner">
    <textarea id="promptInput" rows="1" placeholder="输入需求，直接发给这张卡…"></textarea>
    <button class="stop-btn" id="stopBtn" type="button" hidden>停止</button>
    <button class="send-btn" id="sendBtn" type="button">发送</button>
  </div>
</div>
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
  var composerEl = document.getElementById('composer')
  var promptInput = document.getElementById('promptInput')
  var sendBtn = document.getElementById('sendBtn')
  var stopBtn = document.getElementById('stopBtn')
  var modelSelect = document.getElementById('modelSelect')
  var effortSelect = document.getElementById('effortSelect')
  var baseTitle = document.title

  // streamId -> { cardId, liveText, items, texts, acts, state }
  var streams = new Map()
  // cardId -> [streamId...]（按首次出现顺序，详情页串联渲染多轮）
  var cardStreams = new Map()
  var cardsById = new Map()
  var columns = []
  var selectedCardId = null
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

  function showNotice(text, isError) {
    noticeEl.textContent = text
    noticeEl.classList.toggle('is-error', Boolean(isError))
    noticeEl.classList.add('show')
    setTimeout(function () { noticeEl.classList.remove('show') }, 4000)
  }

  function postAction(command, okText) {
    return fetch('/api/actions?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    }).then(function (response) {
      if (response.status === 202) {
        if (okText) { showNotice(okText) }
        scheduleSnapshot()
        return true
      }
      if (response.status === 503) {
        showNotice('电脑端窗口暂时不可用，稍后再试', true)
      } else {
        showNotice('操作失败（' + response.status + '）', true)
      }
      return false
    }).catch(function () {
      showNotice('网络错误，操作未送达', true)
      return false
    })
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
    showNotice(text, isError)
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
    if (entry.cardId) {
      var order = cardStreams.get(entry.cardId)
      if (!order) { order = []; cardStreams.set(entry.cardId, order) }
      if (order.indexOf(streamId) < 0) { order.push(streamId) }
    }
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

    if (selectedCardId && entry.cardId === selectedCardId) { renderDetail() }
    else if (kind === 'done' || kind === 'error') { renderList() }
  }

  function streamIdsForCard(card) {
    var order = cardStreams.get(card.id)
    if (order && order.length) { return order }
    return card.streamId ? [card.streamId] : []
  }

  function isCardRunning(card) {
    var ids = streamIdsForCard(card)
    var last = ids.length ? streams.get(ids[ids.length - 1]) : null
    if (last) { return last.state === 'streaming' }
    return card.status === 'streaming'
  }

  function statusOfCard(card) {
    var ids = streamIdsForCard(card)
    var last = ids.length ? streams.get(ids[ids.length - 1]) : null
    if (last) {
      if (last.state === 'streaming') { return 'streaming' }
      if (last.state === 'error') { return 'error' }
      return 'done'
    }
    return card.status
  }

  function renderList() {
    listView.textContent = ''
    var hasAny = false
    columns.forEach(function (column) {
      hasAny = true
      var head = document.createElement('div')
      head.className = 'col-head'
      var colTitle = document.createElement('span')
      colTitle.className = 'col-title'
      colTitle.textContent = column.title
      var addBtn = document.createElement('button')
      addBtn.type = 'button'
      addBtn.className = 'col-add'
      addBtn.textContent = '＋ 新会话'
      addBtn.addEventListener('click', function () {
        postAction({ type: 'add-tab', columnId: column.id }, '已创建新会话')
      })
      head.appendChild(colTitle); head.appendChild(addBtn)
      listView.appendChild(head)
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
        btn.addEventListener('click', function () { openDetail(card.id) })
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

  function renderPickers(card) {
    modelSelect.textContent = ''
    ;(card.modelOptions || []).forEach(function (option) {
      var el = document.createElement('option')
      el.value = option.model
      el.textContent = option.label
      modelSelect.appendChild(el)
    })
    modelSelect.value = card.model || ''
    effortSelect.textContent = ''
    ;(card.reasoningOptions || []).forEach(function (option) {
      var el = document.createElement('option')
      el.value = option.value
      el.textContent = option.label
      effortSelect.appendChild(el)
    })
    if (card.reasoningEffort) { effortSelect.value = card.reasoningEffort }
  }

  modelSelect.addEventListener('change', function () {
    var card = selectedCardId ? cardsById.get(selectedCardId) : null
    if (!card) { return }
    postAction(
      { type: 'set-card-model', cardId: card.id, provider: card.provider, model: modelSelect.value },
      '模型已切换',
    )
  })

  effortSelect.addEventListener('change', function () {
    var card = selectedCardId ? cardsById.get(selectedCardId) : null
    if (!card || !effortSelect.value) { return }
    postAction(
      { type: 'set-card-reasoning-effort', cardId: card.id, reasoningEffort: effortSelect.value },
      '推理档位已调整',
    )
  })

  function openDetail(cardId) {
    selectedCardId = cardId
    var card = cardsById.get(cardId)
    detailTitle.textContent = card ? card.title : ''
    if (card) { renderPickers(card) }
    listView.hidden = true
    detailView.hidden = false
    composerEl.hidden = false
    renderDetail()
    window.scrollTo(0, document.body.scrollHeight)
  }

  document.getElementById('backBtn').addEventListener('click', function () {
    selectedCardId = null
    detailView.hidden = true
    composerEl.hidden = true
    listView.hidden = false
    renderList()
    window.scrollTo(0, 0)
  })

  function sendPrompt() {
    var card = selectedCardId ? cardsById.get(selectedCardId) : null
    var prompt = promptInput.value.trim()
    if (!card || !prompt) { return }
    sendBtn.disabled = true
    postAction({ type: 'send-message', cardId: card.id, prompt: prompt }, '已发送').then(function (ok) {
      sendBtn.disabled = false
      if (ok) {
        promptInput.value = ''
        promptInput.style.height = ''
      }
    })
  }

  sendBtn.addEventListener('click', sendPrompt)
  promptInput.addEventListener('input', function () {
    promptInput.style.height = ''
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px'
  })

  stopBtn.addEventListener('click', function () {
    var card = selectedCardId ? cardsById.get(selectedCardId) : null
    if (!card) { return }
    postAction({ type: 'stop-stream', cardId: card.id }, '已请求停止')
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
      preR.textContent = act.text || act.content || act.summary || ''
      detR.appendChild(sumR); detR.appendChild(preR)
      box.appendChild(detR)
    } else if (act.kind === 'tool') {
      var toolHead = document.createElement('div')
      toolHead.textContent = '🔧 ' + (act.summary || act.toolName || '工具调用')
      box.appendChild(toolHead)
      var inputKeys = act.toolInput ? Object.keys(act.toolInput) : []
      if (inputKeys.length) {
        var detT = document.createElement('details')
        detT.className = 'patch'
        var sumT = document.createElement('summary')
        sumT.textContent = (act.toolName || '工具') + ' 参数'
        detT.appendChild(sumT)
        inputKeys.forEach(function (key) {
          var rowT = document.createElement('div')
          rowT.className = 'tool-input'
          rowT.textContent = key + ': ' + act.toolInput[key]
          detT.appendChild(rowT)
        })
        box.appendChild(detT)
      }
    } else if (act.kind === 'todo') {
      var todoItems = act.items || []
      var doneItems = todoItems.filter(function (it) { return it.status === 'completed' }).length
      var todoHead = document.createElement('div')
      todoHead.textContent = '📋 任务清单 ' + doneItems + '/' + todoItems.length
      box.appendChild(todoHead)
      todoItems.forEach(function (it) {
        var rowI = document.createElement('div')
        rowI.className = 'act-line'
        var mark = it.status === 'completed' ? '✅' : it.status === 'in_progress' ? '▶️' : '⬜'
        rowI.textContent = mark + ' ' + (it.status === 'in_progress' && it.activeForm ? it.activeForm : it.content)
        box.appendChild(rowI)
      })
    } else if (act.kind === 'agents') {
      var agentHead = document.createElement('div')
      agentHead.textContent = '🤖 子智能体' + (act.tool ? ' · ' + act.tool : '')
      box.appendChild(agentHead)
      ;(act.agents || []).forEach(function (agentEntry) {
        var rowA = document.createElement('div')
        rowA.className = 'act-line'
        rowA.textContent = (agentEntry.nickname || agentEntry.role || agentEntry.threadId) + ' · ' + (agentEntry.status || '')
        box.appendChild(rowA)
      })
    } else if (act.kind === 'ask-user') {
      box.classList.add('ask')
      var questionList = act.questions && act.questions.length ? act.questions : [act]
      questionList.forEach(function (questionEntry) {
        var headQ = document.createElement('div')
        headQ.textContent = '❓ ' + (questionEntry.question || '等待你的输入')
        box.appendChild(headQ)
        ;(questionEntry.options || []).forEach(function (option) {
          var rowO = document.createElement('div')
          rowO.className = 'act-line'
          rowO.textContent = '· ' + option.label + (option.description ? '：' + option.description : '')
          box.appendChild(rowO)
        })
      })
    } else if (act.kind === 'compaction') {
      box.textContent = '🗜️ 上下文已压缩，会话继续'
    } else {
      box.textContent = '⚙️ ' + (act.kind || 'activity')
    }
    container.appendChild(box)
  }

  function renderStreamInto(container, entry, isLast) {
    entry.items.forEach(function (item) {
      if (item.type === 'text') {
        var msg = document.createElement('div')
        msg.className = 'msg'
        msg.textContent = entry.texts.get(item.id) || ''
        container.appendChild(msg)
      } else {
        renderActivity(container, entry.acts.get(item.id) || {})
      }
    })
    if (entry.liveText) {
      var live = document.createElement('div')
      live.className = 'msg live'
      live.textContent = entry.liveText
      container.appendChild(live)
    }
    if (entry.state !== 'streaming' && isLast) {
      var doneEl = document.createElement('div')
      doneEl.className = 'act'
      doneEl.textContent = entry.state === 'error' ? '❌ 本轮出错结束' : entry.state === 'stopped' ? '⏹ 已停止' : '✅ 本轮已完成'
      container.appendChild(doneEl)
    }
  }

  function updateComposerState(card) {
    var running = card ? isCardRunning(card) : false
    stopBtn.hidden = !running
  }

  function renderDetail() {
    detailBody.textContent = ''
    var card = selectedCardId ? cardsById.get(selectedCardId) : null
    updateComposerState(card)
    var ids = card ? streamIdsForCard(card) : []
    var known = ids.filter(function (id) { return streams.has(id) })
    if (!card || known.length === 0) {
      var emptyEl = document.createElement('div')
      emptyEl.className = 'empty'
      emptyEl.textContent = '这张卡当前没有活跃输出，输入需求即可开始'
      detailBody.appendChild(emptyEl)
      return
    }
    var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160
    known.forEach(function (id, index) {
      renderStreamInto(detailBody, streams.get(id), index === known.length - 1)
    })
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
        if (!selectedCardId) { renderList() }
        else {
          var card = cardsById.get(selectedCardId)
          if (card) {
            detailTitle.textContent = card.title
            renderPickers(card)
            updateComposerState(card)
          }
        }
      })
      .catch(function () {})
  }

  function scheduleSnapshot() {
    if (snapshotTimer) { return }
    snapshotTimer = setTimeout(function () {
      snapshotTimer = null
      loadSnapshot()
    }, 1200)
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
