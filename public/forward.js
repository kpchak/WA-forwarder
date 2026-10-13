'use strict';

// Auto-Forward tab. Loaded after app.js, so it reuses _esc() and is called by
// the tab switcher there via initForwardTab().

let _fwdRules   = [];
let _fwdPending = [];
let _fwdInit    = false;

function initForwardTab() {
  if (!_fwdInit) {
    _fwdInit = true;
    document.getElementById('fwdFormToggle').addEventListener('click', _fwdToggleForm);
    document.getElementById('fwdReloadBtn').addEventListener('click', loadForwardRules);
    document.getElementById('fwdSaveBtn').addEventListener('click', _fwdSaveRule);
    document.getElementById('fwdTargetType').addEventListener('change', _fwdFillTargets);
  }
  loadForwardRules();
}

function _fwdToggleForm() {
  const body = document.getElementById('fwdFormBody');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  document.getElementById('fwdFormToggle').textContent = open ? '▼ Expand' : '▲ Collapse';
  if (!open) _fwdFillPickers();
}

async function loadForwardRules() {
  try {
    const res  = await fetch('/api/forward-rules');
    const data = await res.json();
    _fwdRules   = data.rules   || [];
    _fwdPending = data.pending || [];
    _fwdRenderPending();
    _fwdRenderRules();
  } catch (err) {
    document.getElementById('fwdRulesList').innerHTML =
      `<p style="color:#c62828;font-size:0.9rem;">Could not load rules: ${_esc(err.message)}</p>`;
  }
}

// Source groups come from the cached WhatsApp sweep — deliberately the cached
// one, so opening this form never triggers the heavy getChats() call.
async function _fwdFillPickers() {
  const sourceSel = document.getElementById('fwdSource');
  try {
    const res  = await fetch('/api/chat-messages/wa-groups');
    const data = await res.json();
    const list = data.groups || [];
    sourceSel.innerHTML = '<option value="">— select a group —</option>' +
      list.map((g) => `<option value="${_esc(g.id)}">${_esc(g.name)}</option>`).join('');
  } catch (err) {
    sourceSel.innerHTML = '<option value="">Open Groups → WhatsApp Groups → Load first</option>';
  }
  _fwdFillTargets();
}

async function _fwdFillTargets() {
  const type = document.getElementById('fwdTargetType').value;
  const sel  = document.getElementById('fwdTarget');
  // Always lead with an empty option. Without one the browser pre-selects the
  // first entry — in sheet-group mode that is the largest list on the sheet, so
  // saving a rule without touching this dropdown would quietly target everyone.
  const placeholder = '<option value="">— select a target —</option>';

  if (type === 'sheetGroup') {
    try {
      const res  = await fetch('/api/groups');
      const data = await res.json();
      sel.innerHTML = placeholder + (data.groups || [])
        .map((g) => {
          const n = g.members ? g.members.length : 0;
          return `<option value="${_esc(g.name)}">${_esc(g.name)} (${n} member${n === 1 ? '' : 's'})</option>`;
        })
        .join('');
    } catch (err) {
      sel.innerHTML = '<option value="">Could not load sheet groups</option>';
    }
  } else {
    const src = document.getElementById('fwdSource');
    sel.innerHTML = placeholder + Array.from(src.options)
      .filter((o) => o.value)
      .map((o) => `<option value="${_esc(o.value)}">${_esc(o.textContent)}</option>`)
      .join('');
  }
}

async function _fwdSaveRule() {
  const out  = document.getElementById('fwdFormResult');
  const type = document.getElementById('fwdTargetType').value;
  const body = {
    label:         document.getElementById('fwdLabel').value,
    sourceGroupId: document.getElementById('fwdSource').value,
    keywords:      document.getElementById('fwdKeywords').value.split(',').map((k) => k.trim()).filter(Boolean),
    requireLink:   document.getElementById('fwdRequireLink').checked,
    windowStart:   document.getElementById('fwdWindowStart').value,
    windowEnd:     document.getElementById('fwdWindowEnd').value,
    pollMinutes:   Number(document.getElementById('fwdPollMinutes').value) || 5,
    targetType:    type,
    prefix:        document.getElementById('fwdPrefix').value,
    suffix:        document.getElementById('fwdSuffix').value,
  };
  if (type === 'sheetGroup') body.targetSheetGroup = document.getElementById('fwdTarget').value;
  else                       body.targetChatId     = document.getElementById('fwdTarget').value;

  out.style.display = 'block';
  if (!body.sourceGroupId) {
    out.innerHTML = '<span style="color:#c62828">Pick a source group.</span>';
    return;
  }
  if (!body.targetSheetGroup && !body.targetChatId) {
    out.innerHTML = '<span style="color:#c62828">Pick a target — who should receive the forward.</span>';
    return;
  }

  try {
    const res = await fetch('/api/forward-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    out.innerHTML = '<span style="color:#2e7d32">Saved — switched off. Use “Check now” before turning it on.</span>';
    document.getElementById('fwdLabel').value = '';
    loadForwardRules();
  } catch (err) {
    out.innerHTML = `<span style="color:#c62828">${_esc(err.message)}</span>`;
  }
}

function _fwdRenderRules() {
  const el = document.getElementById('fwdRulesList');
  if (!_fwdRules.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No rules yet.</p>';
    return;
  }

  el.innerHTML = _fwdRules.map((r) => {
    const target = r.targetType === 'chat' ? `group ${r.targetChatId}` : `${r.targetSheetGroup} (each member)`;
    const when   = (r.windowStart && r.windowEnd) ? `${r.windowStart}–${r.windowEnd}` : 'any time';
    const keys   = (r.keywords || []).length ? (r.keywords || []).join(', ') : 'any message';
    return `<div class="fwd-rule" data-id="${_esc(r.id)}">
      <div class="fwd-rule-head">
        <span class="fwd-rule-name">${_esc(r.label)}</span>
        <span class="badge ${r.active ? 'badge-count' : 'badge-unmatched'}">${r.active ? 'ON' : 'OFF'}</span>
        <span class="badge badge-count">${r.mode === 'auto' ? 'auto-send' : 'needs approval'}</span>
      </div>
      <div class="fwd-rule-meta">watches <code>${_esc(r.sourceGroupId)}</code> · ${_esc(when)} ·
        keywords: ${_esc(keys)} · every ${r.pollMinutes} min → <strong>${_esc(target)}</strong></div>
      <div class="fwd-rule-actions">
        <select class="form-input fwd-range" title="Which days to look at">
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="all">Everything fetched</option>
        </select>
        <button class="btn btn-ghost fwd-check">🔍 Check now</button>
        <button class="btn btn-ghost fwd-toggle">${r.active ? '⏸ Turn off' : '▶ Turn on'}</button>
        <button class="btn btn-ghost fwd-mode">${r.mode === 'auto' ? 'Require approval' : 'Send automatically'}</button>
        <button class="btn btn-danger fwd-del">Delete</button>
      </div></div>`;
  }).join('');

  el.querySelectorAll('.fwd-rule').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.fwd-check').addEventListener('click', () => _fwdCheckNow(id, row));
    row.querySelector('.fwd-toggle').addEventListener('click', () => {
      const r = _fwdRules.find((x) => x.id === id);
      _fwdUpdate(id, { active: !r.active });
    });
    row.querySelector('.fwd-mode').addEventListener('click', () => {
      const r = _fwdRules.find((x) => x.id === id);
      if (r.mode !== 'auto' &&
          !confirm('Send every match automatically, with no approval step?')) return;
      _fwdUpdate(id, { mode: r.mode === 'auto' ? 'approve' : 'auto' });
    });
    row.querySelector('.fwd-del').addEventListener('click', () => {
      if (confirm('Delete this rule?')) _fwdDelete(id);
    });
  });
}

async function _fwdUpdate(id, patch) {
  await fetch(`/api/forward-rules/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  loadForwardRules();
}

async function _fwdDelete(id) {
  await fetch(`/api/forward-rules/${encodeURIComponent(id)}?confirm=1`, { method: 'DELETE' });
  loadForwardRules();
}

/** Local-day boundaries, so "today" means today where you are, not in UTC. */
function _fwdRange(choice) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);

  if (choice === 'all')       return null;
  if (choice === 'today')     return { from: start.getTime(), to: end.getTime() };
  if (choice === 'yesterday') {
    return { from: start.getTime() - 86400000, to: start.getTime() - 1 };
  }
  const days = Number(choice) || 7;
  return { from: start.getTime() - (days - 1) * 86400000, to: end.getTime() };
}

async function _fwdCheckNow(id, row) {
  const btn = row.querySelector('.fwd-check');
  btn.disabled = true;
  btn.textContent = '⏳ Checking…';
  try {
    const range = _fwdRange(row.querySelector('.fwd-range').value);
    const res   = await fetch(`/api/forward-rules/${encodeURIComponent(id)}/check-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(range || {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Check failed');
    btn.textContent = `${(data.matches || []).length} match(es)`;
    _fwdPending = data.pending || [];
    _fwdRenderPending();
  } catch (err) {
    btn.textContent = `⚠ ${err.message.slice(0, 40)}`;
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = '🔍 Check now'; }, 4000);
}

function _fwdRenderPending() {
  const el   = document.getElementById('fwdPendingList');
  const open = _fwdPending.filter((p) => p.status === 'pending');
  document.getElementById('fwdPendingCount').textContent =
    open.length ? `${open.length} waiting` : 'nothing waiting';

  if (!open.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">Nothing is waiting for approval.</p>';
    return;
  }

  el.innerHTML = open.map((p) => `
    <div class="fwd-pending" data-id="${_esc(p.id)}">
      <div class="fwd-rule-meta">${_esc(p.ruleLabel)} · from ${_esc(p.author)} ·
        ${new Date(p.timestamp * 1000).toLocaleString()}${p.hasMedia ? ' · <strong>has an attachment</strong>' : ''}</div>
      <div class="fwd-pending-body">${_esc(p.body || '(no text)')}</div>
      <div class="fwd-rule-actions">
        <button class="btn btn-primary fwd-approve">✅ Send it</button>
        <button class="btn btn-ghost fwd-dismiss">Dismiss</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.fwd-pending').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.fwd-approve').addEventListener('click', () => _fwdApprove(id, row));
    row.querySelector('.fwd-dismiss').addEventListener('click', () => _fwdDismiss(id));
  });
}

async function _fwdApprove(id, row) {
  if (!confirm('Send this message now?')) return;
  const btn = row.querySelector('.fwd-approve');
  btn.disabled = true;
  btn.textContent = '⏳ Sending…';
  try {
    const res  = await fetch(`/api/forward-rules/pending/${encodeURIComponent(id)}/approve`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    const r = data.result || {};
    alert(`Sent to ${r.sent} recipient(s)${r.failed ? `, ${r.failed} failed` : ''}` +
      (r.mediaExpected && !r.mediaIncluded ? '\n\nThe attachment could not be included — text only.' : ''));
    _fwdPending = data.pending || [];
    _fwdRenderPending();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✅ Send it';
    alert(`Could not send: ${err.message}`);
  }
}

async function _fwdDismiss(id) {
  const res  = await fetch(`/api/forward-rules/pending/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
  const data = await res.json();
  _fwdPending = data.pending || [];
  _fwdRenderPending();
}
