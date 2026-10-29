// The HTTP layer must replace __LORE_NONCE__ and set matching script/style CSP nonces.
export const workspacePage: string = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lore 工作区</title>
<style nonce="__LORE_NONCE__">
:root { color-scheme: light dark; --bg:#f4f5f7; --panel:#fff; --text:#20262e; --muted:#606975; --line:#d9dee5; --accent:#185c46; --accent-text:#fff; --error:#a12828; --notice:#795500; --removed:#873535; --added:#226743; }
@media (prefers-color-scheme: dark) { :root { --bg:#171b20; --panel:#20262d; --text:#e7ebef; --muted:#aeb8c4; --line:#414b58; --accent:#88d6b5; --accent-text:#142b23; --error:#ffaaaa; --notice:#ecd08a; --removed:#ffb3b3; --added:#a5e4b9; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif; }
main { max-width:1120px; margin:auto; padding:28px 24px 48px; }
header { margin-bottom:22px; } h1 { margin:0; font-size:26px; letter-spacing:.03em; } h2 { font-size:18px; margin:0 0 12px; } p { margin:8px 0; }
.subtitle,.muted { color:var(--muted); font-size:14px; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px; min-width:0; }
.workspace { margin-bottom:18px; } .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; } .between { justify-content:space-between; }
#directory { overflow-wrap:anywhere; margin:12px 0; } .label { font-size:13px; color:var(--muted); }
button { font:inherit; border:1px solid var(--line); border-radius:7px; padding:8px 14px; color:var(--text); background:var(--panel); cursor:pointer; }
button.primary { background:var(--accent); color:var(--accent-text); border-color:var(--accent); }
button:disabled { opacity:.45; cursor:not-allowed; } button:focus-visible,textarea:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
.layout { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(0,1fr); gap:18px; align-items:start; }
#messages { min-height:180px; max-height:480px; overflow:auto; padding-right:4px; }
.message { margin:0 0 18px; } .message strong { font-size:13px; color:var(--muted); } .message p { white-space:pre-wrap; overflow-wrap:anywhere; margin-top:4px; }
textarea { width:100%; resize:vertical; min-height:115px; max-height:340px; border:1px solid var(--line); border-radius:8px; padding:12px; color:var(--text); background:var(--panel); font:inherit; margin:8px 0; }
#status { font-size:14px; color:var(--muted); } #error { color:var(--error); white-space:pre-wrap; overflow-wrap:anywhere; } #notice { color:var(--notice); white-space:pre-wrap; overflow-wrap:anywhere; }
[hidden] { display:none !important; } #events { max-height:320px; overflow:auto; margin:0; padding-left:22px; font-size:14px; } #events li { margin:0 0 9px; overflow-wrap:anywhere; }
.changes { margin-top:18px; } details { border-top:1px solid var(--line); padding:10px 0; } summary { cursor:pointer; overflow-wrap:anywhere; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.55 ui-monospace,Consolas,monospace; border:1px solid var(--line); border-radius:6px; padding:10px; max-height:340px; overflow:auto; margin:6px 0 14px; }
.before { color:var(--removed); } .after { color:var(--added); } .diff-label { font-size:13px; margin-top:10px; }
@media(max-width:760px) { main { padding:20px 16px 32px; } .layout { grid-template-columns:1fr; } .panel { padding:16px; } button { min-height:42px; } h1 { font-size:23px; } }
</style>
</head>
<body>
<main>
<header><h1>Lore 工作区</h1><p class="subtitle">在选定目录内读取、搜索和修改文本文件。</p></header>
<section class="panel workspace" aria-labelledby="workspace-title">
<div class="row between"><h2 id="workspace-title">工作区</h2><div class="row"><button id="select" disabled>选择文件夹</button><button id="reset" disabled>新会话</button><button id="refresh">刷新状态</button></div></div>
<div class="label">当前目录</div><p id="directory">尚未选择工作区</p>
<p id="status" role="status" aria-live="polite">正在读取会话…</p>
<p id="error" role="alert" hidden></p><p id="notice" role="status" hidden></p>
</section>
<div class="layout">
<section class="panel" aria-labelledby="chat-title">
<h2 id="chat-title">对话</h2><div id="messages" aria-label="对话记录"><p class="muted">选择工作区后，描述你希望完成的任务。</p></div>
<form id="composer"><label for="message">任务或追问</label><textarea id="message" maxlength="8000" placeholder="例如：读取项目说明，整理一份待办清单。" disabled></textarea><div class="row between"><span class="muted">最多 8000 字符</span><div class="row"><button id="cancel" type="button" disabled>取消执行</button><button id="send" class="primary" type="submit" disabled>发送</button></div></div></form>
<p class="muted">取消不会撤销已完成的文件写入。会话仅保存在本次服务运行期间。</p>
</section>
<aside class="panel" aria-label="执行详情"><h2>执行过程</h2><p id="events-empty" class="muted">尚无执行记录</p><ol id="events" aria-label="执行事件"></ol><div class="changes"><h2>文件变更</h2><p id="changes-empty" class="muted">尚无已确认的文件变更</p><div id="changes"></div></div></aside>
</div>
</main>
<script nonce="__LORE_NONCE__">
(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries(['select','reset','refresh','directory','status','error','notice','messages','composer','message','send','cancel','events','events-empty','changes','changes-empty'].map((id) => [id, byId(id)]));
  let session = null;
  let ready = false;
  let busy = false;
  let uncertain = false;
  let runId = null;
  let pollTimer = null;
  let polling = false;
  let cancelling = false;
  let cancelRequested = false;
  let shownEvents = 0;
  let shownChanges = '';
  const errorLabels = {
    PICKER_BUSY:'目录选择窗口已打开，请先完成或取消选择。',
    PICKER_UNAVAILABLE:'目录选择器需要可交互的 Windows 桌面。',
    PICKER_FAILED:'目录选择失败，请重试。',
    PICKER_TIMEOUT:'目录选择超时，请重新选择。',
    PICKER_ABORTED:'目录选择已取消。',
    SESSION_BUSY:'当前会话仍在执行，请等待结束。',
    WORKSPACE_BUSY:'当前任务或目录选择仍在进行，请等待结束。',
    CONTEXT_LIMIT:'必要的上下文超过上限，请开启新会话。',
    SESSION_NOT_FOUND:'会话已失效，请刷新状态并重新选择工作区。',
    SESSION_MISMATCH:'会话已改变，请刷新状态。',
    RUN_NOT_FOUND:'执行记录不可用，请刷新会话状态确认是否结束。',
    MODEL_NOT_CONFIGURED:'尚未配置模型，请检查本机服务配置。',
    MODEL_ERROR:'模型调用失败。',
    INVALID_REQUEST:'请求无效，请检查输入。',
    ABORTED:'执行已取消；已完成的文件写入仍然保留。',
    TIMEOUT:'执行超时；请检查已完成的文件变更。',
    STEP_LIMIT:'已达到执行步数上限。',
    CONTEXT_TOO_LARGE:'必要的上下文超过上限，请缩短任务或开启新会话。',
    TOOL_ERROR:'工具执行失败，请检查执行过程和已完成的变更。',
    NETWORK:'连接失败，请检查本机服务。',
    INVALID_RESPONSE:'服务响应无效，请刷新状态。'
  };
  const eventLabels = { started:'开始执行', model_step_completed:'模型步骤完成', tool_requested:'请求工具', tool_completed:'工具完成', tool_failed:'工具失败', tool_input_invalid:'工具参数无效', finished:'执行结束' };
  const statusLabels = { running:'执行中', requested:'已请求', succeeded:'成功', failed:'失败', completed:'完成', ABORTED:'已取消', TIMEOUT:'超时', STEP_LIMIT:'达到步数上限' };
  const text = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  function showError(error) {
    const code = error && typeof error.code === 'string' ? error.code : 'NETWORK';
    ui.error.textContent = errorLabels[code] || '操作失败，请检查本机服务后刷新状态。';
    ui.error.hidden = false;
  }
  function clearError() { ui.error.hidden = true; ui.error.textContent = ''; }
  function showNotice(data) {
    if (data && data.notice) { ui.notice.textContent = text(data.notice); ui.notice.hidden = false; }
  }
  async function request(path, body) {
    let response;
    try {
      response = await fetch(path, { method:body === undefined ? 'GET' : 'POST', mode:'same-origin', credentials:'same-origin', cache:'no-store', headers:body === undefined ? { Accept:'application/json' } : { Accept:'application/json', 'Content-Type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
    } catch { throw { code:'NETWORK', uncertain:true }; }
    let data;
    try { data = await response.json(); } catch { throw { code:'INVALID_RESPONSE', uncertain:true }; }
    if (!data || typeof data !== 'object') throw { code:'INVALID_RESPONSE', uncertain:true };
    showNotice(data);
    if (!response.ok) {
      const error = data.error || data;
      throw { code:typeof error === 'string' ? error : error.code, uncertain:response.status >= 500 };
    }
    return data;
  }
  function updateControls() {
    const active = Boolean(runId || (session && session.running) || uncertain);
    const locked = !ready || busy || active;
    ui.select.disabled = locked;
    ui.reset.disabled = locked || !session;
    ui.refresh.disabled = busy || polling;
    ui.message.disabled = !session || locked;
    ui.send.disabled = !session || locked || !ui.message.value.trim();
    ui.cancel.disabled = !runId || cancelling || cancelRequested;
    ui.select.textContent = session ? '切换工作区' : '选择文件夹';
    ui.directory.textContent = session ? session.root : '尚未选择工作区';
  }
  function renderMessages() {
    ui.messages.replaceChildren();
    for (const message of session ? session.messages : []) {
      const article = document.createElement('article'); article.className = 'message';
      const role = document.createElement('strong'); role.textContent = message.role === 'user' ? '你' : 'Lore';
      const content = document.createElement('p'); content.textContent = message.content;
      article.append(role, content); ui.messages.append(article);
    }
    if (!ui.messages.childElementCount) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '选择工作区后，描述你希望完成的任务。'; ui.messages.append(empty);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }
  function resetDetails() {
    shownEvents = 0; shownChanges = ''; ui.events.replaceChildren(); ui.changes.replaceChildren();
    ui['events-empty'].hidden = false; ui['changes-empty'].hidden = false;
    ui.notice.hidden = true; ui.notice.textContent = '';
  }
  function validateSession(data) {
    if (!Object.hasOwn(data, 'session') || (data.session !== null && (!data.session || typeof data.session.id !== 'string' || typeof data.session.root !== 'string' || typeof data.session.running !== 'boolean' || !Array.isArray(data.session.messages)))) throw { code:'INVALID_RESPONSE', uncertain:true };
    return data.session;
  }
  async function loadSession() {
    const data = await request('/workspace/session');
    session = validateSession(data); ready = true; uncertain = false;
    renderMessages(); updateControls();
    return data;
  }
  async function refresh() {
    if (busy || polling) return;
    if (runId) { clearTimeout(pollTimer); await poll(); return; }
    busy = true; clearError(); updateControls();
    try {
      await loadSession();
      runId = session && typeof session.runId === 'string' ? session.runId : null;
      ui.status.textContent = session && session.running ? '会话正在执行，正在恢复执行记录…' : session ? '工作区已就绪' : '请选择一个工作区目录';
      if (runId) { cancelRequested = false; void poll(); }
    } catch (error) { showError(error); ui.status.textContent = '会话状态尚未确认，请刷新重试。'; }
    finally { busy = false; updateControls(); }
  }
  async function selectWorkspace(fresh) {
    if (ui.select.disabled) return;
    busy = true; clearError(); ui.status.textContent = '请在本机目录窗口中选择文件夹…'; updateControls();
    try {
      if (fresh) {
        await request('/workspace/reset', {});
        session = null; renderMessages(); resetDetails(); updateControls();
      }
      const data = await request('/workspace/select', {});
      if (data.cancelled) { ui.status.textContent = '已取消目录选择'; return; }
      session = validateSession(data);
      if (!session) throw { code:'INVALID_RESPONSE', uncertain:true };
      resetDetails(); showNotice(data); renderMessages();
      ui.status.textContent = '工作区已就绪';
    } catch (error) {
      showError(error);
      // Selection/reset can have completed even when the response was lost.
      try { await loadSession(); } catch { uncertain = true; }
      ui.status.textContent = uncertain ? '会话状态尚未确认，请刷新重试。' : '请检查提示后重试';
    } finally { busy = false; updateControls(); }
  }
  function renderRun(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    if (events.length < shownEvents) { ui.events.replaceChildren(); shownEvents = 0; }
    for (const event of events.slice(shownEvents)) {
      const item = document.createElement('li');
      const target = event.path || event.relativePath;
      item.textContent = [eventLabels[event.event] || text(event.event), event.tool, target, statusLabels[event.status] || text(event.status), Number.isFinite(event.durationMs) ? event.durationMs + ' ms' : ''].filter(Boolean).join(' · ');
      ui.events.append(item);
    }
    shownEvents = events.length; ui['events-empty'].hidden = shownEvents > 0;
    const changes = Array.isArray(data.changes) ? data.changes : [];
    const signature = JSON.stringify(changes);
    if (signature !== shownChanges) {
      shownChanges = signature; ui.changes.replaceChildren();
      for (const change of changes) {
        const details = document.createElement('details'); const summary = document.createElement('summary');
        summary.textContent = (change.kind === 'created' || change.kind === 'create' ? '新建' : '修改') + ' · ' + text(change.path); details.append(summary);
        for (const [key, label, prefix] of [['before','修改前','- '],['after','修改后','+ ']]) {
          const heading = document.createElement('p'); heading.className = 'diff-label'; heading.textContent = label;
          const content = document.createElement('pre'); content.className = key;
          content.textContent = change[key] == null ? '（无内容）' : text(change[key]).split('\n').map((line) => prefix + line).join('\n');
          details.append(heading, content);
        }
        ui.changes.append(details);
      }
    }
    ui['changes-empty'].hidden = changes.length > 0;
  }
  async function poll() {
    if (!runId || polling) return;
    const currentId = runId; polling = true; updateControls();
    let finished = false;
    try {
      const data = await request('/workspace/run/' + encodeURIComponent(currentId));
      if (data.id !== currentId || !['running','finished'].includes(data.status)) throw { code:'INVALID_RESPONSE' };
      renderRun(data);
      if (data.status === 'finished') {
        finished = true; runId = null; uncertain = true;
        const result = data.result;
        const error = data.error || (result && result.error) || (result && result.finishReason !== 'completed' ? { code:result.finishReason } : null);
        ui.status.textContent = error ? '执行已结束，请检查结果和已完成的变更。' : '执行完成';
        clearError(); if (error) showError(error);
        const failedTools = result && Array.isArray(result.steps) && result.steps.some((step) => step.status === 'failed');
        if (failedTools && !error) { ui.status.textContent = '执行结束，部分工具操作失败，请查看详情。'; showError({code:'TOOL_ERROR'}); }
        // Keep sends locked until the canonical session (including history) is refreshed.
        try { await loadSession(); } catch (error) { uncertain = true; showError(error); ui.status.textContent = '执行已结束；会话同步失败，请刷新状态后继续。'; }
      } else {
        clearError(); ui.status.textContent = cancelRequested ? '已请求取消，等待执行结束；已完成的写入仍然保留。' : '正在执行…';
      }
    } catch (error) {
      showError(error); ui.status.textContent = '连接或状态查询失败，执行状态尚未确认；正在重试。';
    } finally {
      polling = false; updateControls();
      if (!finished && runId === currentId) pollTimer = setTimeout(poll, 1200);
    }
  }
  ui.composer.addEventListener('submit', async (event) => {
    event.preventDefault(); if (ui.send.disabled) return;
    const message = ui.message.value.trim(); busy = true; clearError(); resetDetails(); ui.status.textContent = '正在提交任务…'; updateControls();
    try {
      const data = await request('/workspace/invoke', { sessionId:session.id, message });
      if (typeof data.runId !== 'string' || !data.runId) throw { code:'INVALID_RESPONSE', uncertain:true };
      runId = data.runId; session.running = true; session.messages.push({ role:'user', content:message });
      cancelRequested = false; ui.message.value = ''; renderMessages(); void poll();
    } catch (error) {
      showError(error);
      if (error.uncertain) { uncertain = true; ui.status.textContent = '任务是否已提交尚未确认，请刷新状态。'; }
      else {
        ui.status.textContent = '任务提交失败';
        try { await loadSession(); } catch { uncertain = true; }
      }
    } finally { busy = false; updateControls(); }
  });
  ui.cancel.addEventListener('click', async () => {
    if (ui.cancel.disabled) return;
    const cancellingRunId = runId;
    cancelling = true; clearError(); updateControls();
    try {
      await request('/workspace/run/' + encodeURIComponent(cancellingRunId) + '/cancel', {});
      if (runId === cancellingRunId) { cancelRequested = true; ui.status.textContent = '已请求取消，等待执行结束；已完成的写入仍然保留。'; }
    }
    catch (error) { if (runId === cancellingRunId) { showError(error); ui.status.textContent = '取消请求未确认，继续查询执行状态。'; } }
    finally { cancelling = false; updateControls(); }
  });
  ui.message.addEventListener('input', updateControls);
  ui.select.addEventListener('click', () => selectWorkspace(false));
  ui.reset.addEventListener('click', () => selectWorkspace(true));
  ui.refresh.addEventListener('click', refresh);
  void refresh();
})();
</script>
</body>
</html>`;
