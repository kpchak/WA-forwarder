'use strict';

// ── Saved message templates ───────────────────────────────────────────────────
let _savedTemplates = [];   // cached from server

async function loadSavedTemplates() {
  try {
    const res = await fetch('/api/templates');
    const d   = await res.json();
    _savedTemplates = d.templates || [];
  } catch (_) {}
}

async function refreshTemplateSelects() {
  await loadSavedTemplates();
  document.querySelectorAll('.tpl-select').forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = '<option value="">📋 Load template…</option>'
      + _savedTemplates.map((t) =>
          `<option value="${t.id}">${_esc(t.name)}</option>`
        ).join('');
    sel.value = current; // restore selection if still present
  });
}

function initTemplateLoaders() {
  document.querySelectorAll('.tpl-loader-row').forEach((row) => {
    const targetId  = row.dataset.target;
    const previewId = row.dataset.preview;

    // ── Select dropdown ──────────────────────────────────────────────────────
    const sel = document.createElement('select');
    sel.className = 'tpl-select';
    sel.innerHTML = '<option value="">📋 Load template…</option>';
    row.appendChild(sel);

    // ── Load button ──────────────────────────────────────────────────────────
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'tpl-load-btn';
    loadBtn.textContent = '↓ Load';
    row.appendChild(loadBtn);

    loadBtn.addEventListener('click', () => {
      const tpl = _savedTemplates.find((t) => t.id === sel.value);
      if (!tpl) return;
      const ta = document.getElementById(targetId);
      if (!ta) return;
      ta.value = tpl.text;
      ta.focus();
      ta.dispatchEvent(new Event('input'));
      updatePreview(ta, previewId);
    });

    // ── Save button ──────────────────────────────────────────────────────────
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'tpl-save-btn';
    saveBtn.textContent = '💾 Save';
    row.appendChild(saveBtn);

    // ── Delete button ────────────────────────────────────────────────────────
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'tpl-del-btn';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete selected template';
    row.appendChild(delBtn);

    delBtn.addEventListener('click', async () => {
      const id  = sel.value;
      const tpl = _savedTemplates.find((t) => t.id === id);
      if (!tpl) return;
      if (!confirm(`Delete template "${tpl.name}"?`)) return;
      await fetch(`/api/templates/${id}`, { method: 'DELETE' });
      await refreshTemplateSelects();
    });

    // ── Inline save form (shown on Save click) ───────────────────────────────
    const form = document.createElement('div');
    form.className = 'tpl-save-form';
    form.style.display = 'none';

    const nameInput = document.createElement('input');
    nameInput.type  = 'text';
    nameInput.placeholder = 'Template name…';
    form.appendChild(nameInput);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'tpl-confirm-btn';
    confirmBtn.textContent = 'Save';
    form.appendChild(confirmBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'tpl-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    form.appendChild(cancelBtn);

    // Insert form right after the row
    row.insertAdjacentElement('afterend', form);

    saveBtn.addEventListener('click', () => {
      const ta = document.getElementById(targetId);
      if (!ta?.value.trim()) return;
      // Pre-fill name from selected template if one is loaded
      const tpl = _savedTemplates.find((t) => t.id === sel.value);
      nameInput.value = tpl ? tpl.name : '';
      form.style.display = 'flex';
      nameInput.focus();
    });

    cancelBtn.addEventListener('click', () => {
      form.style.display = 'none';
      nameInput.value = '';
    });

    confirmBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const ta   = document.getElementById(targetId);
      if (!name) { nameInput.focus(); return; }
      if (!ta?.value.trim()) return;

      const res  = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text: ta.value }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error); return; }

      form.style.display = 'none';
      nameInput.value = '';
      await refreshTemplateSelects();

      // Auto-select the just-saved template
      const saved = (data.templates || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (saved) document.querySelectorAll('.tpl-select').forEach((s) => { s.value = saved.id; });
    });

    // Allow Enter key in name input
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
    });
  });

  // Initial load
  refreshTemplateSelects();
}

// ── Template system ───────────────────────────────────────────────────────────

const DAYS_FULL   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS_FULL = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// Mirror of server-side resolveTemplates — used for live preview only
function resolveTemplates(text, now = new Date()) {
  if (!text) return text;
  return text
    .replace(/<day>([+-]\d+)?/g, (_, offset) => String(now.getDate() + (offset ? parseInt(offset,10) : 0)))
    .replace(/<weekday>/g, DAYS_FULL[now.getDay()])
    .replace(/<month>/g, MONTHS_FULL[now.getMonth()])
    .replace(/<year>/g, String(now.getFullYear()));
}

function hasTemplates(text) {
  return /<(day|weekday|month|year)>/.test(text || '');
}

// Template chips: { label, variable, hint(date) }
function buildTemplateChips(now = new Date()) {
  return [
    { var: '<weekday>', hint: DAYS_FULL[now.getDay()],   tip: 'Day name' },
    { var: '<day>',     hint: now.getDate(),              tip: 'Day of month' },
    { var: '<day>-1',   hint: now.getDate() - 1,         tip: 'Yesterday' },
    { var: '<day>+1',   hint: now.getDate() + 1,         tip: 'Tomorrow' },
    { var: '<day>-2',   hint: now.getDate() - 2,         tip: '2 days ago' },
    { var: '<day>+2',   hint: now.getDate() + 2,         tip: '2 days ahead' },
    { var: '<day>-7',   hint: now.getDate() - 7,         tip: 'Last week' },
    { var: '<day>+7',   hint: now.getDate() + 7,         tip: 'Next week' },
    { var: '<month>',   hint: MONTHS_FULL[now.getMonth()], tip: 'Month name' },
    { var: '<year>',    hint: now.getFullYear(),          tip: 'Year' },
  ];
}

// Build every .template-bar on the page
function initTemplateBars() {
  const now = new Date();
  document.querySelectorAll('.template-bar').forEach((bar) => {
    const targetId  = bar.dataset.target;
    const previewId = targetId === 'sendText' ? 'sendPreview' : 'schedPreview';

    buildTemplateChips(now).forEach(({ var: variable, hint, tip }) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tpl-chip';
      chip.title = tip;
      chip.innerHTML = `<span class="tpl-chip-var">${variable}</span><span class="tpl-chip-val">→ ${hint}</span>`;

      chip.addEventListener('click', () => {
        const ta = document.getElementById(targetId);
        if (!ta) return;
        const start = ta.selectionStart ?? ta.value.length;
        const end   = ta.selectionEnd   ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + variable + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + variable.length;
        ta.focus();
        ta.dispatchEvent(new Event('input'));
      });

      bar.appendChild(chip);
    });

    // Live preview on textarea input
    const ta = document.getElementById(targetId);
    if (ta) {
      ta.addEventListener('input', () => updatePreview(ta, previewId));
    }
  });
}

function updatePreview(ta, previewId) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  if (hasTemplates(ta.value)) {
    preview.textContent = resolveTemplates(ta.value);
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
}

// Initialise after DOM is ready (called at bottom of file)

// ── Emoji bars ────────────────────────────────────────────────────────────────
const EMOJIS = [
  { e: '👍', label: 'Thumbs up' },
  { e: '🙏', label: 'Thank you' },
  { e: '❤️', label: 'Love' },
  { e: '😊', label: 'Smile' },
  { e: '😄', label: 'Happy' },
  { e: '🎉', label: 'Celebrate' },
  { e: '🎊', label: 'Party' },
  { e: '✅', label: 'Done' },
  { e: '👏', label: 'Clap' },
  { e: '🙌', label: 'Hands up' },
  { e: '💪', label: 'Strong' },
  { e: '🌟', label: 'Star' },
  { e: '✨', label: 'Sparkles' },
  { e: '🔥', label: 'Fire' },
  { e: '💯', label: '100%' },
  { e: '👋', label: 'Hello / Bye' },
  { e: '🤝', label: 'Handshake' },
  { e: '💐', label: 'Flowers' },
  { e: '🌺', label: 'Flower' },
  { e: '😍', label: 'Love it' },
  { e: '🥳', label: 'Party face' },
  { e: '💫', label: 'Dizzy' },
  { e: '🎯', label: 'Target' },
  { e: '📢', label: 'Announcement' },
  { e: '⏰', label: 'Reminder' },
  { e: '📅', label: 'Calendar' },
  { e: '📝', label: 'Note' },
  { e: '✔️', label: 'Tick' },
  { e: '🙂', label: 'Slightly smiling' },
  { e: '😇', label: 'Blessed' },
];

// Build every .emoji-bar on the page
document.querySelectorAll('.emoji-bar').forEach((bar) => {
  const targetId = bar.dataset.target;
  EMOJIS.forEach(({ e, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.title = label;
    btn.addEventListener('click', () => {
      const ta = document.getElementById(targetId);
      if (!ta) return;
      const start = ta.selectionStart ?? ta.value.length;
      const end   = ta.selectionEnd   ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + e + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + [...e].length;
      ta.focus();
      ta.dispatchEvent(new Event('input')); // update char counter
    });
    bar.appendChild(btn);
  });
});

// Initialise template bars and saved template loaders
initTemplateBars();
initTemplateLoaders();

// ── Socket.IO — WebSocket only ────────────────────────────────────────────────
const socket = io({ transports: ['websocket'] });

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const viewInit       = document.getElementById('viewInitializing');
const viewQR         = document.getElementById('viewQR');
const viewConnected  = document.getElementById('viewConnected');
const viewDisconnect = document.getElementById('viewDisconnected');
const qrImage        = document.getElementById('qrImage');
const qrCountdown    = document.getElementById('qrCountdown');
const qrSeconds      = document.getElementById('qrSeconds');
const clearBtn       = document.getElementById('clearSessionBtn');
const reconnectBtn   = document.getElementById('reconnectBtn');

// Tab buttons and panels
const tabBtns   = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

// Tabs that require WhatsApp to be connected before they're usable
const REQUIRES_CONNECTED = ['groups', 'send', 'schedule', 'attendance', 'messages'];

// ── State ─────────────────────────────────────────────────────────────────────
let qrTimer = null;

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('connect', () => {
  console.log('[Socket] Connected, id:', socket.id);
});

socket.on('disconnect', () => {
  console.log('[Socket] Disconnected from server');
});

socket.on('wa:status', ({ state, qr }) => {
  console.log('[WA] Status:', state);
  renderState(state, qr);
});

// ── Render ────────────────────────────────────────────────────────────────────
function renderState(state, qr) {
  // Stop any running QR countdown
  stopCountdown();

  // Hide all views first
  hide(viewInit, viewQR, viewConnected, viewDisconnect);

  switch (state) {
    case 'stopped':
    case 'initializing':
      setStatus(state === 'ready' ? 'ready' : state, labelFor(state));
      show(viewInit);
      setTabsEnabled(false);
      break;

    case 'qr':
      setStatus('qr', 'Scan QR Code');
      show(viewQR);
      qrImage.src = qr || '';
      startCountdown(20);
      setTabsEnabled(false);
      break;

    case 'ready':
      setStatus('ready', 'Connected');
      show(viewConnected);
      setTabsEnabled(true);
      break;

    case 'disconnected':
      setStatus('disconnected', 'Disconnected');
      show(viewDisconnect);
      setTabsEnabled(false);
      break;

    default:
      setStatus('stopped', 'Unknown');
      show(viewInit);
  }
}

function labelFor(state) {
  return {
    stopped: 'Starting…',
    initializing: 'Connecting…',
    qr: 'Scan QR Code',
    ready: 'Connected',
    disconnected: 'Disconnected',
  }[state] || state;
}

// ── QR countdown ──────────────────────────────────────────────────────────────
function startCountdown(seconds) {
  qrCountdown.style.display = 'inline-flex';
  qrSeconds.textContent = seconds;
  let remaining = seconds;
  qrTimer = setInterval(() => {
    remaining--;
    qrSeconds.textContent = remaining;
    if (remaining <= 0) stopCountdown();
  }, 1000);
}

function stopCountdown() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  qrCountdown.style.display = 'none';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setTabsEnabled(connected) {
  tabBtns.forEach((btn) => {
    const tab = btn.dataset.tab;
    if (REQUIRES_CONNECTED.includes(tab)) {
      btn.disabled = !connected;
    }
  });
}

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    tabBtns.forEach((b) => b.classList.remove('active'));
    tabPanels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    document.getElementById(`tab-${tabId}`).classList.add('active');
    if (tabId === 'groups')     loadGroups();
    if (tabId === 'send')       initSendTab();
    if (tabId === 'schedule')   initScheduleTab();
    if (tabId === 'attendance') initAttendanceTab();
    if (tabId === 'messages')   initMessagesTab();
  });
});

// ── Buttons ───────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (confirm('This will log out WhatsApp and delete the saved session. You will need to scan a new QR code. Continue?')) {
    socket.emit('session:clear');
  }
});

reconnectBtn.addEventListener('click', () => {
  socket.emit('session:clear');
});

// ── Groups ────────────────────────────────────────────────────────────────────
const groupsGrid        = document.getElementById('groupsGrid');
const groupsLoading     = document.getElementById('groupsLoading');
const groupsError       = document.getElementById('groupsError');
const groupsNotConfig   = document.getElementById('groupsNotConfigured');
const groupsCacheAge    = document.getElementById('groupsCacheAge');
const refreshGroupsBtn  = document.getElementById('refreshGroupsBtn');

refreshGroupsBtn.addEventListener('click', () => syncGroups());

// Load from local file — fast, no network
async function loadGroups() {
  groupsLoading.style.display   = 'block';
  groupsError.style.display     = 'none';
  groupsNotConfig.style.display = 'none';
  groupsGrid.innerHTML          = '';

  try {
    const res  = await fetch('/api/groups');
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    groupsLoading.style.display = 'none';
    _renderGroups(data);
  } catch (err) {
    groupsLoading.style.display = 'none';
    groupsError.style.display   = 'block';
    groupsError.textContent     = `Failed to load groups: ${err.message}`;
  }
}

// Fetch fresh data from Google Sheets then re-render
async function syncGroups() {
  refreshGroupsBtn.disabled    = true;
  refreshGroupsBtn.textContent = '⏳ Syncing…';
  groupsError.style.display    = 'none';

  try {
    const res  = await fetch('/api/groups/sync', { method: 'POST' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Server error ${res.status}`);
    }
    const data = await res.json();
    groupsGrid.innerHTML = '';
    _renderGroups({ configured: true, groups: data.groups, storeInfo: data.storeInfo });
  } catch (err) {
    groupsError.style.display = 'block';
    groupsError.textContent   = `Sync failed: ${err.message}`;
  } finally {
    refreshGroupsBtn.disabled    = false;
    refreshGroupsBtn.textContent = '🔄 Refresh';
  }
}

function _renderGroups(data) {
  if (!data.configured) {
    groupsNotConfig.style.display = 'block';
    return;
  }

  if (data.storeInfo?.savedAt) {
    const d = new Date(data.storeInfo.savedAt);
    groupsCacheAge.textContent = `Saved ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    groupsCacheAge.textContent = 'Not yet synced from Sheets';
  }

  if (!data.groups || data.groups.length === 0) {
    groupsGrid.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">No groups found. Click Refresh to sync from Google Sheets.</p>';
    return;
  }

  data.groups.forEach((group) => groupsGrid.appendChild(buildGroupCard(group)));
}

function buildGroupCard(group) {
  const card = document.createElement('div');
  card.className = 'group-card';

  card.innerHTML = `
    <div class="group-card-header" data-expanded="false">
      <span class="group-name" title="${_esc(group.name)}">👥 ${_esc(group.name)}</span>
      <div class="group-badges">
        <span class="badge badge-count">${group.members?.length || 0} members</span>
        <span class="badge badge-chevron">▼</span>
      </div>
    </div>
    <div class="member-list">
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Phone</th>${group.members[0]?.attendanceCode !== undefined ? '<th>Code</th>' : ''}</tr></thead>
        <tbody>
          ${group.members.map((m, i) => `
            <tr>
              <td style="color:var(--text-muted)">${i + 1}</td>
              <td>${m.name || '—'}</td>
              <td style="font-family:monospace">${m.phone || '—'}</td>
              ${m.attendanceCode !== undefined ? `<td>${m.attendanceCode || '—'}</td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const header   = card.querySelector('.group-card-header');
  const list     = card.querySelector('.member-list');
  const chevron  = card.querySelector('.badge-chevron');

  header.addEventListener('click', () => {
    const expanded = header.dataset.expanded === 'true';
    header.dataset.expanded = String(!expanded);
    list.classList.toggle('open', !expanded);
    chevron.classList.toggle('open', !expanded);
  });

  return card;
}

// ── Send Messages ─────────────────────────────────────────────────────────────
const sendGroup     = document.getElementById('sendGroup');
const sendGroupHint = document.getElementById('sendGroupHint');
const sendText      = document.getElementById('sendText');
const sendCharCount = document.getElementById('sendCharCount');
const sendFile      = document.getElementById('sendFile');
const filePickerLbl = document.getElementById('filePickerLabel');
const filePreview   = document.getElementById('filePreview');
const filePreviewImg  = document.getElementById('filePreviewImg');
const filePreviewName = document.getElementById('filePreviewName');
const filePreviewSize = document.getElementById('filePreviewSize');
const removeFileBtn = document.getElementById('removeFileBtn');
const sendBtn       = document.getElementById('sendBtn');
const clearSendBtn  = document.getElementById('clearSendBtn');
const sendResult    = document.getElementById('sendResult');

let _sendFileData = null; // { base64, mimetype, filename }
let _sendTabReady = false;

async function initSendTab() {
  if (_sendTabReady) return;
  _sendTabReady = true;
  await _loadSendGroups();
}

async function _loadSendGroups() {
  try {
    const res  = await fetch('/api/messages/groups');
    const data = await res.json();
    sendGroup.innerHTML = '<option value="">— select a group —</option>';
    (data.groups || []).forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = `${g.name}  (${g.memberCount} members)`;
      sendGroup.appendChild(opt);
    });
  } catch (e) {
    sendGroup.innerHTML = '<option value="">Failed to load groups</option>';
  }
}

sendGroup.addEventListener('change', () => {
  sendGroupHint.textContent = '';
});

sendText.addEventListener('input', () => {
  sendCharCount.textContent = `${sendText.value.length} characters`;
});

sendFile.addEventListener('change', () => {
  const file = sendFile.files[0];
  if (!file) return;

  if (file.size > 16 * 1024 * 1024) {
    showSendResult('error', 'File is too large (max 16 MB).');
    sendFile.value = '';
    return;
  }

  filePickerLbl.textContent = '📎 ' + file.name;
  filePreviewName.textContent = file.name;
  filePreviewSize.textContent = _formatBytes(file.size);

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl  = e.target.result;
    const [header, base64] = dataUrl.split(',');
    const mimetype = header.match(/:(.*?);/)[1];
    _sendFileData  = { base64, mimetype, filename: file.name };

    if (mimetype.startsWith('image/')) {
      filePreviewImg.src     = dataUrl;
      filePreviewImg.style.display = 'block';
    } else {
      filePreviewImg.style.display = 'none';
    }
    filePreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
});

removeFileBtn.addEventListener('click', () => {
  _sendFileData           = null;
  sendFile.value          = '';
  filePickerLbl.textContent = '📎 Choose file';
  filePreview.style.display = 'none';
  filePreviewImg.style.display = 'none';
});

sendBtn.addEventListener('click', async () => {
  const groupName = sendGroup.value.trim();
  const text      = sendText.value.trim();

  if (!groupName)       return showSendResult('error', 'Please select a group.');
  if (!text && !_sendFileData) return showSendResult('error', 'Please enter a message or attach a file.');

  sendBtn.disabled    = true;
  sendBtn.textContent = '⏳ Sending…';
  sendResult.style.display = 'none';

  try {
    const body = { groupName, text };
    if (_sendFileData) body.media = _sendFileData;

    const res  = await fetch('/api/messages/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    // Build per-member result summary
    const failRows = (data.results || [])
      .filter((r) => !r.ok)
      .map((r) => `<li>${_esc(r.name || r.phone)}: ${_esc(r.error)}</li>`)
      .join('');

    const html = `✅ Sent to <strong>${data.sent}</strong> of <strong>${data.total}</strong> members in <strong>${_esc(groupName)}</strong>`
      + (failRows ? `<br/><small style="color:var(--danger)">Failed:<ul style="margin:4px 0 0 16px">${failRows}</ul></small>` : '');

    showSendResult(data.failed === 0 ? 'ok' : 'error', html);
  } catch (err) {
    showSendResult('error', `❌ ${err.message}`);
  } finally {
    sendBtn.disabled    = false;
    sendBtn.textContent = '📤 Send';
  }
});

clearSendBtn.addEventListener('click', () => {
  sendGroup.value   = '';
  sendText.value    = '';
  sendCharCount.textContent = '0 characters';
  sendGroupHint.textContent = '';
  removeFileBtn.click();
  sendResult.style.display = 'none';
  _sendTabReady = false; // re-fetch groups next open
  _sendTabReady = true;
});

function showSendResult(type, html) {
  sendResult.className    = `send-result-box ${type === 'ok' ? 'send-result-ok' : 'send-result-err'}`;
  sendResult.innerHTML    = html;
  sendResult.style.display = 'block';
}

function _formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Schedule Messages ─────────────────────────────────────────────────────────
const schedGroup       = document.getElementById('schedGroup');
const schedLabel       = document.getElementById('schedLabel');
const schedText        = document.getElementById('schedText');
const schedFile        = document.getElementById('schedFile');
const schedFileLabel   = document.getElementById('schedFileLabel');
const schedFilePreview = document.getElementById('schedFilePreview');
const schedFileImg     = document.getElementById('schedFileImg');
const schedFileName    = document.getElementById('schedFileName');
const schedFileSize    = document.getElementById('schedFileSize');
const schedRemoveFile  = document.getElementById('schedRemoveFile');
const schedTime        = document.getElementById('schedTime');
const schedDaysGroup   = document.getElementById('schedDaysGroup');
const schedDomGroup    = document.getElementById('schedDomGroup');
const schedSaveBtn     = document.getElementById('schedSaveBtn');
const schedClearBtn    = document.getElementById('schedClearBtn');
const schedFormResult  = document.getElementById('schedFormResult');
const schedFormToggle  = document.getElementById('schedFormToggle');
const schedFormBody    = document.getElementById('schedFormBody');
const schedList        = document.getElementById('schedList');
const schedCount       = document.getElementById('schedCount');

let _schedFileData = null;
let _schedTabReady = false;

async function initScheduleTab() {
  if (_schedTabReady) return;
  _schedTabReady = true;
  await _loadSchedGroups();
  await loadSchedules();
  _updateTimezoneHint();
}

async function _loadSchedGroups() {
  try {
    const res  = await fetch('/api/messages/groups');
    const data = await res.json();
    schedGroup.innerHTML = '<option value="">— select a group —</option>';
    (data.groups || []).forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = `${g.name}  (${g.memberCount} members)`;
      schedGroup.appendChild(opt);
    });
  } catch (_) {}
}

// Schedule type radio → show/hide day/dom/once-date fields
document.querySelectorAll('input[name="schedType"]').forEach((r) => {
  r.addEventListener('change', () => {
    const type = r.value;
    document.getElementById('schedOnceDateGroup').style.display = type === 'once'    ? 'flex' : 'none';
    schedDaysGroup.style.display                                = type === 'weekly'  ? 'flex' : 'none';
    schedDomGroup.style.display                                 = type === 'monthly' ? 'flex' : 'none';
  });
});

// File picker
schedFile.addEventListener('change', () => {
  const file = schedFile.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    _showSchedResult('error', 'Attachment must be under 5 MB for scheduled messages.');
    schedFile.value = '';
    return;
  }
  schedFileLabel.textContent = '📎 ' + file.name;
  schedFileName.textContent  = file.name;
  schedFileSize.textContent  = _formatBytes(file.size);
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const [header, base64] = dataUrl.split(',');
    const mimetype = header.match(/:(.*?);/)[1];
    _schedFileData = { base64, mimetype, filename: file.name };
    if (mimetype.startsWith('image/')) { schedFileImg.src = dataUrl; schedFileImg.style.display = 'block'; }
    else schedFileImg.style.display = 'none';
    schedFilePreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
});

schedRemoveFile.addEventListener('click', () => {
  _schedFileData = null; schedFile.value = '';
  schedFileLabel.textContent = '📎 Choose file';
  schedFilePreview.style.display = 'none';
  schedFileImg.style.display = 'none';
});

// Collapse/expand form
schedFormToggle.addEventListener('click', () => {
  const collapsed = schedFormBody.style.display === 'none';
  schedFormBody.style.display = collapsed ? 'block' : 'none';
  schedFormToggle.textContent = collapsed ? '▲ Collapse' : '▼ Expand';
});

// Save
schedSaveBtn.addEventListener('click', async () => {
  const groupName = schedGroup.value.trim();
  const text      = schedText.value.trim();
  const type      = document.querySelector('input[name="schedType"]:checked')?.value;

  if (!groupName) return _showSchedResult('error', 'Please select a group.');
  if (!text && !_schedFileData) return _showSchedResult('error', 'Please enter a message or attach a file.');

  const days = Array.from(document.querySelectorAll('input[name="schedDay"]:checked')).map((cb) => +cb.value);

  if (type === 'once') {
    const dateVal = document.getElementById('schedOnceDate').value;
    if (!dateVal) return _showSchedResult('error', 'Please pick a date for the one-time send.');
    const runAt = new Date(`${dateVal}T${schedTime.value}:00`);
    if (runAt <= new Date()) return _showSchedResult('error', 'Please pick a future date and time.');
  }

  const body = {
    groupName,
    label:       schedLabel.value.trim(),
    text,
    media:       _schedFileData,
    scheduleType: type,
    time:        schedTime.value,
    date:        type === 'once' ? document.getElementById('schedOnceDate').value : undefined,
    days,
    dayOfMonth:  parseInt(document.getElementById('schedDom').value, 10) || 1,
  };

  schedSaveBtn.disabled    = true;
  schedSaveBtn.textContent = '⏳ Saving…';

  try {
    const res  = await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    _showSchedResult('ok', `✅ Schedule saved — next run: ${_fmtNextRun(data.schedule.nextRun)}`);
    _schedClearForm();
    await loadSchedules();
  } catch (err) {
    _showSchedResult('error', `❌ ${err.message}`);
  } finally {
    schedSaveBtn.disabled    = false;
    schedSaveBtn.textContent = '💾 Save Schedule';
  }
});

schedClearBtn.addEventListener('click', _schedClearForm);

function _schedClearForm() {
  schedLabel.value = ''; schedGroup.value = ''; schedText.value = '';
  schedTime.value  = '09:00';
  document.querySelector('input[name="schedType"][value="daily"]').checked = true;
  document.getElementById('schedOnceDateGroup').style.display = 'none';
  document.getElementById('schedOnceDate').value = '';
  schedDaysGroup.style.display = 'none'; schedDomGroup.style.display = 'none';
  schedRemoveFile.click();
  schedFormResult.style.display = 'none';
}

// Load / render schedule list
async function loadSchedules() {
  try {
    const res  = await fetch('/api/schedules');
    const data = await res.json();
    _renderSchedules(data.schedules || []);
  } catch (err) {
    schedList.innerHTML = `<p style="color:var(--danger);font-size:0.88rem">Failed to load schedules: ${err.message}</p>`;
  }
}

function _renderSchedules(schedules) {
  schedCount.textContent = schedules.length ? `${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}` : '';
  if (!schedules.length) {
    schedList.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;text-align:center;padding:24px 0">No schedules yet.</p>';
    return;
  }
  schedList.innerHTML = '';
  schedules.forEach((s) => schedList.appendChild(_buildSchedCard(s)));
}

function _buildSchedCard(s) {
  const card = document.createElement('div');
  card.className = `sched-card${s.active ? '' : ' paused'}`;
  card.dataset.id = s.id;

  const title    = s.label || `${s.groupName}`;
  const typeLabel = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[s.scheduleType] || s.scheduleType;
  const dayNames  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let whenStr = `${typeLabel} at ${s.time}`;
  if (s.scheduleType === 'once' && s.date) whenStr = `Once on ${s.date} at ${s.time}`;
  if (s.scheduleType === 'weekly' && s.days?.length) whenStr += ` · ${s.days.map((d) => dayNames[d]).join(', ')}`;
  if (s.scheduleType === 'monthly') whenStr += ` · Day ${s.dayOfMonth}`;

  const nextRunStr = s.scheduleType === 'once' && s.lastRun
    ? 'Sent ✓'
    : s.nextRun ? `Next: ${_fmtNextRun(s.nextRun)}` : 'Paused';
  const lastRunStr = s.lastRun ? `Last: ${new Date(s.lastRun).toLocaleString()}` : 'Never run';
  const preview    = s.text ? (s.text.length > 80 ? s.text.slice(0, 80) + '…' : s.text) : (s.media ? `📎 ${s.media.filename}` : '');

  card.innerHTML = `
    <div class="sched-card-body">
      <div class="sched-card-title">${title} <span style="font-weight:400;color:var(--text-muted);font-size:0.82rem">— ${s.groupName}</span></div>
      <div class="sched-card-meta">
        <span>🕐 ${whenStr}</span>
        <span>${nextRunStr}</span>
        <span style="color:#90a4ae">${lastRunStr}</span>
      </div>
      ${preview ? `<div class="sched-card-preview">"${preview}"</div>` : ''}
    </div>
    <div class="sched-card-actions">
      <button class="btn-toggle ${s.active ? 'active' : ''}" data-action="toggle">
        ${s.active ? '⏸ Pause' : '▶ Resume'}
      </button>
      <button class="btn-del" data-action="delete">🗑 Delete</button>
    </div>`;

  card.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
    try {
      const res  = await fetch(`/api/schedules/${s.id}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await loadSchedules();
    } catch (err) { alert('Toggle failed: ' + err.message); }
  });

  card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete "${title}"?`)) return;
    try {
      await fetch(`/api/schedules/${s.id}`, { method: 'DELETE' });
      await loadSchedules();
    } catch (err) { alert('Delete failed: ' + err.message); }
  });

  return card;
}

function _fmtNextRun(iso) {
  if (!iso) return '—';
  const d   = new Date(iso);
  const now = new Date();
  const diffH = (d - now) / 3600000;
  if (diffH < 24) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (diffH < 48) return `Tomorrow ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
         ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function _showSchedResult(type, html) {
  schedFormResult.className    = `send-result-box ${type === 'ok' ? 'send-result-ok' : 'send-result-err'}`;
  schedFormResult.innerHTML    = html;
  schedFormResult.style.display = 'block';
}

function _updateTimezoneHint() {
  const tzEl = document.getElementById('schedTimezone');
  if (tzEl) tzEl.textContent = `Times are server-side (IST/Asia Kolkata by default)`;
}

// ── Attendance ────────────────────────────────────────────────────────────────
const attGroup        = document.getElementById('attGroup');
const attDate         = document.getElementById('attDate');
const attLoadBtn      = document.getElementById('attLoadBtn');
const attExportBtn    = document.getElementById('attExportBtn');
const attStats        = document.getElementById('attStats');
const attLoading      = document.getElementById('attLoading');
const attError        = document.getElementById('attError');
const attEmpty        = document.getElementById('attEmpty');
const attTableWrap    = document.getElementById('attTableWrap');
const attTbody        = document.getElementById('attTbody');
const attMarkAll      = document.getElementById('attMarkAllPresent');
const attClearAll     = document.getElementById('attClearAll');
const cfgGroup        = document.getElementById('cfgGroup');
const cfgPresent      = document.getElementById('cfgPresent');
const cfgLate         = document.getElementById('cfgLate');
const cfgAbsent       = document.getElementById('cfgAbsent');
const cfgSaveBtn      = document.getElementById('cfgSaveBtn');
const cfgResult       = document.getElementById('cfgResult');

let _attCurrentData   = null;  // last loaded { date, group, members, summary }

async function initAttendanceTab() {
  // Set date to today if empty
  if (!attDate.value) attDate.value = _todayStr();
  await _populateAttGroupDropdowns();
  attEmpty.style.display = 'block';
}

async function _populateAttGroupDropdowns() {
  try {
    const res  = await fetch('/api/messages/groups');
    const data = await res.json();
    const opts = '<option value="">— select —</option>' +
      (data.groups || []).map((g) => `<option value="${_esc(g.name)}">${_esc(g.name)}</option>`).join('');
    attGroup.innerHTML = opts;
    cfgGroup.innerHTML = opts;
    cfgGroup.addEventListener('change', _loadCfgForGroup);
  } catch (_) {}
}

// ── Load attendance ────────────────────────────────────────────────────────────
attLoadBtn.addEventListener('click', loadAttendance);

async function loadAttendance() {
  const group = attGroup.value;
  const date  = attDate.value || _todayStr();
  if (!group) { attError.textContent = 'Please select a group.'; attError.style.display = 'block'; return; }

  attLoading.style.display   = 'block';
  attError.style.display     = 'none';
  attEmpty.style.display     = 'none';
  attTableWrap.style.display = 'none';
  attStats.style.display     = 'none';

  try {
    const res  = await fetch(`/api/attendance?group=${encodeURIComponent(group)}&date=${date}`);
    if (!res.ok) throw new Error((await res.json()).error || `Error ${res.status}`);
    const data = await res.json();
    _attCurrentData = data;
    attLoading.style.display = 'none';
    _renderAttendance(data);
  } catch (err) {
    attLoading.style.display = 'none';
    attError.textContent     = err.message;
    attError.style.display   = 'block';
  }
}

function _renderAttendance({ date, group, members, summary }) {
  // Stats
  document.getElementById('statPresent').textContent  = summary.present;
  document.getElementById('statLate').textContent     = summary.late;
  document.getElementById('statAbsent').textContent   = summary.absent;
  document.getElementById('statUnmarked').textContent =
    members.filter((m) => m.status === 'unmarked').length;
  attStats.style.display = 'grid';

  // Table
  attTbody.innerHTML = '';
  members.forEach((m, i) => attTbody.appendChild(_buildAttRow(m, i + 1, group, date)));

  attTableWrap.style.display = 'block';
}

function _buildAttRow(m, idx, group, date) {
  const tr = document.createElement('tr');

  const statusHtml = `
    <span class="status-pill ${m.status}">
      ${{ present:'✅ Present', late:'⏰ Late', absent:'❌ Absent', unmarked:'— Unmarked' }[m.status] || m.status}
    </span>
    ${m.source ? `<span class="source-badge ${m.source}">${m.source}</span>` : ''}`;

  const timeStr = m.timestamp
    ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';

  tr.innerHTML = `
    <td style="color:var(--text-muted)">${idx}</td>
    <td><strong>${_esc(m.memberName)}</strong></td>
    <td style="font-family:monospace;font-size:0.8rem">${_esc(m.memberPhone)}</td>
    <td>${statusHtml}</td>
    <td style="font-family:monospace">${_esc(m.code) || '—'}</td>
    <td style="white-space:nowrap">${timeStr}</td>
    <td>
      <div class="att-action-btns">
        <button class="att-btn btn-p"   data-status="present">✅</button>
        <button class="att-btn btn-l"   data-status="late">⏰</button>
        <button class="att-btn btn-a"   data-status="absent">❌</button>
        <button class="att-btn btn-clr" data-status="clear">🗑</button>
      </div>
    </td>`;

  tr.querySelectorAll('.att-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.status;
      try {
        if (status === 'clear') {
          await fetch('/api/attendance/unmark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupName: group, memberPhone: m.memberPhone, date }),
          });
        } else {
          await fetch('/api/attendance/mark', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupName: group, memberPhone: m.memberPhone, memberName: m.memberName, date, status }),
          });
        }
        await loadAttendance();
      } catch (err) { alert('Error: ' + err.message); }
    });
  });

  return tr;
}

// Mark all unmarked as present
attMarkAll.addEventListener('click', async () => {
  if (!_attCurrentData) return;
  const { group, date, members } = _attCurrentData;
  const unmarked = members.filter((m) => m.status === 'unmarked');
  if (!unmarked.length) return;
  if (!confirm(`Mark ${unmarked.length} unmarked members as Present?`)) return;
  for (const m of unmarked) {
    await fetch('/api/attendance/mark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupName: group, memberPhone: m.memberPhone, memberName: m.memberName, date, status: 'present' }),
    });
  }
  await loadAttendance();
});

// Clear all records for the day
attClearAll.addEventListener('click', async () => {
  if (!_attCurrentData) return;
  const { group, date, members } = _attCurrentData;
  if (!confirm(`Remove all attendance records for ${group} on ${date}?`)) return;
  for (const m of members.filter((m) => m.status !== 'unmarked')) {
    await fetch('/api/attendance/unmark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupName: group, memberPhone: m.memberPhone, date }),
    });
  }
  await loadAttendance();
});

// Export CSV
attExportBtn.addEventListener('click', () => {
  const group = attGroup.value;
  const date  = attDate.value || _todayStr();
  if (!group) return;
  window.location.href = `/api/attendance/export?group=${encodeURIComponent(group)}&from=${date}&to=${date}`;
});

// ── Auto-refresh on incoming attendance ────────────────────────────────────────
socket.on('attendance:new', (record) => {
  // Refresh the table if we're looking at the affected group/date
  const viewDate  = attDate.value || _todayStr();
  const viewGroup = attGroup.value;
  if (record.groupName === viewGroup && record.date === viewDate) {
    loadAttendance();
  }
});

// ── Code config ────────────────────────────────────────────────────────────────
async function _loadCfgForGroup() {
  const group = cfgGroup.value;
  if (!group) return;
  try {
    const res  = await fetch(`/api/attendance/config?group=${encodeURIComponent(group)}`);
    const cfg  = await res.json();
    cfgPresent.value = (cfg.presentCodes || []).join(', ');
    cfgLate.value    = (cfg.lateCodes    || []).join(', ');
    cfgAbsent.value  = (cfg.absentCodes  || []).join(', ');
  } catch (_) {}
}

cfgSaveBtn.addEventListener('click', async () => {
  const groupName = cfgGroup.value;
  if (!groupName) { cfgResult.className = 'send-result-box send-result-err'; cfgResult.textContent = 'Select a group.'; cfgResult.style.display = 'block'; return; }
  try {
    const body = {
      groupName,
      presentCodes: cfgPresent.value.split(',').map((s) => s.trim()).filter(Boolean),
      lateCodes:    cfgLate.value.split(',').map((s) => s.trim()).filter(Boolean),
      absentCodes:  cfgAbsent.value.split(',').map((s) => s.trim()).filter(Boolean),
    };
    const res = await fetch('/api/attendance/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error);
    cfgResult.className    = 'send-result-box send-result-ok';
    cfgResult.textContent  = '✅ Codes saved';
    cfgResult.style.display = 'block';
  } catch (err) {
    cfgResult.className    = 'send-result-box send-result-err';
    cfgResult.textContent  = '❌ ' + err.message;
    cfgResult.style.display = 'block';
  }
});

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── View Messages tab ─────────────────────────────────────────────────────────
let _vmsgTabReady  = false;
let _vmsgGroupsData = [];      // [{ name, members:[{name,phone}] }] from sheets
let _vmsgContacts   = [];      // current group's members
let _vmsgMessages   = [];      // loaded messages (full, incl. mine)
let _vmsgSelected   = new Set();

const msgGroupSel          = document.getElementById('msgGroupSel');
const msgContactsSection   = document.getElementById('msgContactsSection');
const msgContactsList      = document.getElementById('msgContactsList');
const msgContactsHint      = document.getElementById('msgContactsHint');
const msgSelAllContacts    = document.getElementById('msgSelAllContacts');
const msgDeselAllContacts  = document.getElementById('msgDeselAllContacts');
const msgFrom              = document.getElementById('msgFrom');
const msgTo                = document.getElementById('msgTo');
const msgLoadBtn           = document.getElementById('msgLoadBtn');
const msgShowMine          = document.getElementById('msgShowMine');
const msgLoading           = document.getElementById('msgLoading');
const msgError             = document.getElementById('msgError');
const msgEmpty             = document.getElementById('msgEmpty');
const msgList              = document.getElementById('msgList');
const msgListTitle         = document.getElementById('msgListTitle');
const msgSelectAllWrap     = document.getElementById('msgSelectAllWrap');
const msgSelectAll         = document.getElementById('msgSelectAll');
const msgMarkCard          = document.getElementById('msgMarkCard');
const msgMarkCountLabel    = document.getElementById('msgMarkCountLabel');
const msgMarkAttBtn        = document.getElementById('msgMarkAttBtn');
const msgMarkCodeBtn       = document.getElementById('msgMarkCodeBtn');
const msgCodePanel         = document.getElementById('msgCodePanel');
const msgCodeSel           = document.getElementById('msgCodeSel');
const msgNewCode           = document.getElementById('msgNewCode');
const msgConfirmCodeBtn    = document.getElementById('msgConfirmCodeBtn');
const msgMarkResult        = document.getElementById('msgMarkResult');
const msgForwardCard       = document.getElementById('msgForwardCard');
const msgForwardGroup      = document.getElementById('msgForwardGroup');
const msgForwardCountLabel = document.getElementById('msgForwardCountLabel');
const msgCaption           = document.getElementById('msgCaption');
const msgForwardBtn        = document.getElementById('msgForwardBtn');
const msgClearSelBtn       = document.getElementById('msgClearSelBtn');
const msgForwardResult     = document.getElementById('msgForwardResult');

// ── Date preset helpers ───────────────────────────────────────────────────────
const _vmsgPad = (n) => String(n).padStart(2, '0');
function _vmsgLocalISO(d) {
  return `${d.getFullYear()}-${_vmsgPad(d.getMonth()+1)}-${_vmsgPad(d.getDate())}T${_vmsgPad(d.getHours())}:${_vmsgPad(d.getMinutes())}`;
}
function _vmsgSOD(d) { const r = new Date(d); r.setHours(0,0,0,0); return r; }
function _vmsgEOD(d) { const r = new Date(d); r.setHours(23,59,0,0); return r; }

const _VMSG_PRESETS = {
  today() {
    const now = new Date();
    return [_vmsgSOD(now), now];
  },
  yesterday() {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return [_vmsgSOD(d), _vmsgEOD(d)];
  },
  last7() {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return [_vmsgSOD(d), new Date()];
  },
  thisWeek() {
    const now = new Date();
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return [_vmsgSOD(mon), now];
  },
  thisMonth() {
    const now = new Date();
    return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  },
  lastMonth() {
    const now = new Date();
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59);
    return [s, e];
  },
};

function _vmsgApplyPreset(preset) {
  const [from, to] = _VMSG_PRESETS[preset]();
  msgFrom.value = _vmsgLocalISO(from);
  msgTo.value   = _vmsgLocalISO(to);
  // Highlight active preset button
  document.querySelectorAll('.vmsg-preset-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === preset);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function initMessagesTab() {
  if (_vmsgTabReady) return;
  _vmsgTabReady = true;

  _vmsgApplyPreset('today');
  await _vmsgLoadGroups();
}

async function _vmsgLoadGroups() {
  try {
    const res  = await fetch('/api/groups');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load groups');
    _vmsgGroupsData = data.groups || [];

    msgGroupSel.innerHTML = '<option value="">— select a group —</option>';
    for (const g of _vmsgGroupsData) {
      const opt = document.createElement('option');
      opt.value       = g.name;
      opt.textContent = `${g.name} (${g.members.length})`;
      msgGroupSel.appendChild(opt);
    }

    // Populate forward target with same data
    msgForwardGroup.innerHTML = '<option value="">— select target group —</option>';
    for (const g of _vmsgGroupsData) {
      const opt = document.createElement('option');
      opt.value       = g.name;
      opt.textContent = `${g.name} (${g.members.length} members)`;
      msgForwardGroup.appendChild(opt);
    }
  } catch (err) {
    msgGroupSel.innerHTML = `<option value="">⚠ ${err.message}</option>`;
  }
}

// ── Group change → render contact list ───────────────────────────────────────
msgGroupSel.addEventListener('change', () => {
  const group = _vmsgGroupsData.find((g) => g.name === msgGroupSel.value);
  _vmsgContacts = group ? group.members : [];
  _vmsgRenderContacts();
  _vmsgUpdateContactsHint();
});

function _vmsgRenderContacts() {
  if (!_vmsgContacts.length) {
    msgContactsSection.style.display = 'none';
    return;
  }
  msgContactsSection.style.display = 'block';
  msgContactsList.innerHTML = '';
  for (const m of _vmsgContacts) {
    const label = document.createElement('label');
    label.className = 'vmsg-contact-item';
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = true;
    cb.dataset.phone = m.phone;
    cb.addEventListener('change', _vmsgUpdateContactsHint);
    const nameSpan  = document.createElement('span');
    nameSpan.className = 'vmsg-contact-name';
    nameSpan.textContent = m.name || m.phone;
    const phoneSpan = document.createElement('span');
    phoneSpan.className = 'vmsg-contact-phone';
    phoneSpan.textContent = m.phone;
    label.append(cb, nameSpan, phoneSpan);
    msgContactsList.appendChild(label);
  }
  _vmsgUpdateContactsHint();
}

function _vmsgUpdateContactsHint() {
  const total   = msgContactsList.querySelectorAll('input[type="checkbox"]').length;
  const checked = msgContactsList.querySelectorAll('input[type="checkbox"]:checked').length;
  msgContactsHint.textContent = `${checked} of ${total} contacts selected`;
}

msgSelAllContacts.addEventListener('click', () => {
  msgContactsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
  _vmsgUpdateContactsHint();
});
msgDeselAllContacts.addEventListener('click', () => {
  msgContactsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  _vmsgUpdateContactsHint();
});

// ── Date preset buttons ───────────────────────────────────────────────────────
document.querySelectorAll('.vmsg-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => _vmsgApplyPreset(btn.dataset.preset));
});

// Clear active preset when user edits datetime manually
[msgFrom, msgTo].forEach((el) => {
  el.addEventListener('change', () => {
    document.querySelectorAll('.vmsg-preset-btn').forEach((b) => b.classList.remove('active'));
  });
});

// ── Load messages ─────────────────────────────────────────────────────────────
msgLoadBtn.addEventListener('click', async () => {
  if (!msgGroupSel.value) return _vmsgSetError('Please select a group first.');

  const phones = Array.from(
    msgContactsList.querySelectorAll('input[type="checkbox"]:checked')
  ).map((cb) => cb.dataset.phone);

  if (!phones.length) return _vmsgSetError('Please select at least one contact.');

  _vmsgMessages = [];
  _vmsgSelected.clear();
  _codesLoaded  = false;
  msgCodePanel.style.display  = 'none';
  msgMarkResult.style.display = 'none';
  _vmsgUpdateForwardPanel();

  msgList.style.display          = 'none';
  msgEmpty.style.display         = 'none';
  msgError.style.display         = 'none';
  msgSelectAllWrap.style.display = 'none';
  msgLoading.style.display       = 'block';
  msgListTitle.textContent       = 'Messages';

  try {
    const from = msgFrom.value ? new Date(msgFrom.value).getTime() : null;
    const to   = msgTo.value   ? new Date(msgTo.value).getTime()   : null;

    const res  = await fetch('/api/chat-messages/load', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phones, from, to }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    _vmsgMessages = data.messages || [];
    _vmsgRenderMessages();
  } catch (err) {
    msgLoading.style.display = 'none';
    _vmsgSetError(err.message);
  }
});

msgShowMine.addEventListener('change', () => {
  if (_vmsgMessages.length || msgList.style.display !== 'none') _vmsgRenderMessages();
});

// ── Render message list ───────────────────────────────────────────────────────
function _vmsgRenderMessages() {
  msgLoading.style.display = 'none';
  msgError.style.display   = 'none';

  const showMine = msgShowMine.checked;
  const visible  = showMine ? _vmsgMessages : _vmsgMessages.filter((m) => !m.fromMe);

  if (!visible.length) {
    msgEmpty.textContent = _vmsgMessages.length
      ? 'No messages from contacts in this range. Check "Show my messages" to include yours.'
      : 'No messages found in this time range.';
    msgEmpty.style.display         = 'block';
    msgList.style.display          = 'none';
    msgSelectAllWrap.style.display = 'none';
    msgListTitle.textContent       = 'Messages';
    return;
  }

  msgEmpty.style.display         = 'none';
  msgList.style.display          = 'block';
  msgSelectAllWrap.style.display = 'flex';
  msgListTitle.textContent       = `${visible.length} message${visible.length !== 1 ? 's' : ''}`;

  msgList.innerHTML = '';
  for (const msg of visible) msgList.appendChild(_vmsgBuildRow(msg));
  _vmsgSyncSelectAll();
}

function _vmsgBuildRow(msg) {
  const row = document.createElement('div');
  row.className = `vmsg-row${msg.fromMe ? ' from-me' : ''}`;

  // Resolve contact name from loaded contacts list
  const contact     = _vmsgContacts.find((c) => c.phone === msg.contactPhone);
  const senderLabel = msg.fromMe ? 'Me' : (contact?.name || msg.author || 'Unknown');
  const initial     = msg.fromMe ? 'M' : (senderLabel).slice(0, 1).toUpperCase();
  const timeLabel   = _vmsgFmtTime(msg.timestamp);

  const MEDIA_ICON  = { image:'📷', video:'🎥', audio:'🎵', ptt:'🎤', document:'📄', sticker:'🎨' };
  const MEDIA_LABEL = { image:'Image', video:'Video', audio:'Audio', ptt:'Voice message', document:'Document', sticker:'Sticker' };

  const checkDiv = document.createElement('div');
  checkDiv.className = 'vmsg-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = _vmsgSelected.has(msg.id);
  cb.setAttribute('aria-label', 'Select message');
  checkDiv.appendChild(cb);

  const avatar = document.createElement('div');
  avatar.className   = `vmsg-avatar${msg.fromMe ? ' me' : ''}`;
  avatar.textContent = initial;

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'vmsg-body-wrap';

  const header = document.createElement('div');
  header.className = 'vmsg-header';
  header.innerHTML  = `<span class="vmsg-sender${msg.fromMe ? ' me' : ''}">${_vmsgEsc(senderLabel)}</span>`;
  if (!msg.fromMe && msg.author && msg.author !== contact?.phone) {
    header.innerHTML += `<span class="vmsg-time" style="color:var(--green-dark);font-size:0.72rem">${_vmsgEsc(msg.author)}</span>`;
  }
  header.innerHTML += `<span class="vmsg-time">${timeLabel}</span>`;
  bodyWrap.appendChild(header);

  if (msg.hasMedia) {
    const mediaRow = document.createElement('div');
    mediaRow.className = 'vmsg-media-row';
    const viewBtn = document.createElement('button');
    viewBtn.className = 'vmsg-view-btn'; viewBtn.textContent = '👁 View';
    mediaRow.innerHTML = `<span class="vmsg-media-icon">${MEDIA_ICON[msg.type]||'📎'}</span><span class="vmsg-media-type">${MEDIA_LABEL[msg.type]||'File'}</span>`;
    mediaRow.appendChild(viewBtn);
    bodyWrap.appendChild(mediaRow);
    if (msg.body) {
      const cap = document.createElement('div');
      cap.className = 'vmsg-text'; cap.style.color = 'var(--text-muted)'; cap.style.marginTop = '3px';
      cap.innerHTML = _vmsgEsc(msg.body).replace(/\n/g, '<br>');
      bodyWrap.appendChild(cap);
    }
    const previewEl = document.createElement('div');
    previewEl.className = 'vmsg-media-preview'; previewEl.style.display = 'none';
    bodyWrap.appendChild(previewEl);
    viewBtn.addEventListener('click', () => _vmsgViewMedia(msg.id, viewBtn, previewEl));
  } else if (msg.body) {
    const textEl = document.createElement('div');
    textEl.className = 'vmsg-text';
    textEl.innerHTML = _vmsgEsc(msg.body).replace(/\n/g, '<br>');
    bodyWrap.appendChild(textEl);
  }

  row.append(checkDiv, avatar, bodyWrap);
  cb.addEventListener('change', () => {
    if (cb.checked) _vmsgSelected.add(msg.id);
    else            _vmsgSelected.delete(msg.id);
    _vmsgSyncSelectAll();
    _vmsgUpdateForwardPanel();
  });
  return row;
}

async function _vmsgViewMedia(msgId, btn, previewEl) {
  if (previewEl.style.display !== 'none') {
    previewEl.style.display = 'none'; btn.textContent = '👁 View'; return;
  }
  btn.textContent = '⏳…'; btn.disabled = true;
  try {
    const res  = await fetch(`/api/chat-messages/media/${encodeURIComponent(msgId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const src = `data:${data.mimetype};base64,${data.data}`;
    if (data.mimetype.startsWith('image/')) {
      previewEl.innerHTML = `<img src="${src}" alt="Image" />`;
    } else if (data.mimetype.startsWith('video/')) {
      previewEl.innerHTML = `<video src="${src}" controls></video>`;
    } else {
      const a = document.createElement('a');
      a.href = src; a.download = data.filename; a.textContent = `📥 ${data.filename}`;
      previewEl.innerHTML = ''; previewEl.appendChild(a);
    }
    previewEl.style.display = 'flex'; btn.textContent = '🙈 Hide';
  } catch (err) {
    previewEl.innerHTML = `<span style="padding:8px;color:var(--danger);font-size:0.8rem">⚠ ${_vmsgEsc(err.message)}</span>`;
    previewEl.style.display = 'flex'; btn.textContent = '👁 View';
  } finally { btn.disabled = false; }
}

msgSelectAll.addEventListener('change', () => {
  const visible = _vmsgGetVisible();
  const checked = msgSelectAll.checked;
  for (const msg of visible) { if (checked) _vmsgSelected.add(msg.id); else _vmsgSelected.delete(msg.id); }
  msgList.querySelectorAll('.vmsg-check input').forEach((cb) => { cb.checked = checked; });
  _vmsgUpdateForwardPanel();
});

function _vmsgGetVisible() {
  const base = msgShowMine.checked ? _vmsgMessages : _vmsgMessages.filter((m) => !m.fromMe);
  return _vmsgDedupeMyMsgs(base);
}

// When the same outgoing message was sent to multiple selected contacts
// (e.g. via Send tab), each DM chat contains a copy. Collapse into one.
function _vmsgDedupeMyMsgs(msgs) {
  const seen = new Set();          // dedup all messages by id
  const myBodyTs = [];             // track [body, timestamp] of kept fromMe msgs

  return msgs.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);

    if (m.fromMe) {
      const dup = myBodyTs.some(
        ([b, t]) => b === m.body && Math.abs(t - m.timestamp) < 300 // 5-min window
      );
      if (dup) return false;
      myBodyTs.push([m.body, m.timestamp]);
    }
    return true;
  });
}
function _vmsgSyncSelectAll() {
  const visible = _vmsgGetVisible();
  if (!visible.length) return;
  const allSel  = visible.every((m) => _vmsgSelected.has(m.id));
  const someSel = visible.some((m)  => _vmsgSelected.has(m.id));
  msgSelectAll.checked       = allSel;
  msgSelectAll.indeterminate = !allSel && someSel;
}
function _vmsgUpdateForwardPanel() {
  const n = _vmsgSelected.size;
  const show = n > 0 ? 'block' : 'none';
  msgMarkCard.style.display        = show;
  msgForwardCard.style.display     = show;
  msgMarkCountLabel.textContent    = `${n} message${n !== 1 ? 's' : ''} selected`;
  msgForwardCountLabel.textContent = `${n} message${n !== 1 ? 's' : ''} selected — forward to:`;
}

// Build entry objects from selected messages (only non-fromMe messages)
function _vmsgBuildEntries() {
  return Array.from(_vmsgSelected)
    .map((id) => _vmsgMessages.find((m) => m.id === id))
    .filter((m) => m && !m.fromMe)
    .map((msg) => {
      const contact = _vmsgContacts.find((c) => c.phone === msg.contactPhone);
      return {
        timestamp:  msg.timestamp,
        group:      msgGroupSel.value,
        memberName: contact?.name || msg.author || msg.contactPhone || 'Unknown',
        message:    msg.body || '',
      };
    });
}

// ── Mark Attendance ───────────────────────────────────────────────────────────
msgMarkAttBtn.addEventListener('click', async () => {
  const entries = _vmsgBuildEntries();
  if (!entries.length) return _vmsgSetMarkResult('error', '❌ Select messages from contacts (not your own) to mark attendance.');

  msgMarkAttBtn.disabled = true; msgMarkAttBtn.textContent = '⏳ Marking…';
  msgMarkResult.style.display = 'none';
  try {
    const res  = await fetch('/api/sheet-writer/attendance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _vmsgSetMarkResult('ok', `✅ Attendance marked for ${data.written} message${data.written !== 1 ? 's' : ''} in Google Sheets.`);
  } catch (err) {
    _vmsgSetMarkResult('error', `❌ ${err.message}`);
  } finally {
    msgMarkAttBtn.disabled = false; msgMarkAttBtn.textContent = '✅ Mark Attendance';
  }
});

// ── Mark Code ─────────────────────────────────────────────────────────────────
let _codesLoaded = false;

msgMarkCodeBtn.addEventListener('click', async () => {
  const visible = msgCodePanel.style.display !== 'none';
  if (visible) { msgCodePanel.style.display = 'none'; return; }

  msgCodePanel.style.display = 'block';
  msgMarkResult.style.display = 'none';

  if (!_codesLoaded) {
    msgCodeSel.innerHTML = '<option value="">⏳ Loading…</option>';
    try {
      const res   = await fetch('/api/sheet-writer/codes');
      const data  = await res.json();
      const codes = data.codes || [];
      msgCodeSel.innerHTML = '<option value="">— select existing —</option>';
      codes.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        msgCodeSel.appendChild(opt);
      });
      _codesLoaded = true;
    } catch (err) {
      msgCodeSel.innerHTML = '<option value="">— failed to load —</option>';
    }
  }
});

msgNewCode.addEventListener('input', () => { msgNewCode.value = msgNewCode.value.toUpperCase(); });

msgConfirmCodeBtn.addEventListener('click', async () => {
  const code = msgCodeSel.value.trim() || msgNewCode.value.trim().toUpperCase();
  if (!code) return _vmsgSetMarkResult('error', '❌ Select an existing code or type a new one.');

  const entries = _vmsgBuildEntries();
  if (!entries.length) return _vmsgSetMarkResult('error', '❌ Select messages from contacts (not your own) to mark.');

  msgConfirmCodeBtn.disabled = true; msgConfirmCodeBtn.textContent = '⏳ Saving…';
  msgMarkResult.style.display = 'none';
  try {
    const res  = await fetch('/api/sheet-writer/code-monitor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // Add new code to dropdown if it's fresh
    if (!Array.from(msgCodeSel.options).some((o) => o.value === code)) {
      const opt = document.createElement('option');
      opt.value = code; opt.textContent = code;
      msgCodeSel.appendChild(opt);
    }
    msgNewCode.value = '';
    msgCodePanel.style.display = 'none';
    _vmsgSetMarkResult('ok', `✅ Code <strong>${code}</strong> marked for ${data.written} message${data.written !== 1 ? 's' : ''} in Google Sheets.`);
  } catch (err) {
    _vmsgSetMarkResult('error', `❌ ${err.message}`);
  } finally {
    msgConfirmCodeBtn.disabled = false; msgConfirmCodeBtn.textContent = '🏷 Confirm';
  }
});

function _vmsgSetMarkResult(type, html) {
  msgMarkResult.className    = `send-result-box ${type === 'ok' ? 'send-result-ok' : 'send-result-err'}`;
  msgMarkResult.innerHTML    = html;
  msgMarkResult.style.display = 'block';
}

msgClearSelBtn.addEventListener('click', () => {
  _vmsgSelected.clear();
  msgList.querySelectorAll('.vmsg-check input').forEach((cb) => { cb.checked = false; });
  msgSelectAll.checked = false; msgSelectAll.indeterminate = false;
  _vmsgUpdateForwardPanel();
});

msgForwardBtn.addEventListener('click', async () => {
  if (!_vmsgSelected.size)    return _vmsgSetFwdResult('error', 'No messages selected.');
  if (!msgForwardGroup.value) return _vmsgSetFwdResult('error', 'Please select a target group.');

  msgForwardBtn.disabled = true; msgForwardBtn.textContent = '⏳ Forwarding…';
  msgForwardResult.style.display = 'none';
  try {
    const res  = await fetch('/api/chat-messages/forward', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageIds:      Array.from(_vmsgSelected),
        targetGroupName: msgForwardGroup.value,
        caption:         msgCaption.value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _vmsgSetFwdResult('ok', `✅ Forwarded to ${data.sent} member${data.sent !== 1 ? 's' : ''}${data.failed ? ` · ${data.failed} failed` : ''}`);
  } catch (err) {
    _vmsgSetFwdResult('error', `❌ ${err.message}`);
  } finally {
    msgForwardBtn.disabled = false; msgForwardBtn.textContent = '📤 Forward';
  }
});

function _vmsgSetError(msg) {
  msgError.textContent = msg; msgError.style.display = 'block'; msgEmpty.style.display = 'none';
}
function _vmsgSetFwdResult(type, html) {
  msgForwardResult.className    = `send-result-box ${type === 'ok' ? 'send-result-ok' : 'send-result-err'}`;
  msgForwardResult.innerHTML    = html;
  msgForwardResult.style.display = 'block';
}
function _vmsgFmtTime(unixSec) {
  const d = new Date(unixSec * 1000), now = new Date();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${t}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday ${t}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + t;
}
function _vmsgEsc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function show(...els) {
  els.forEach((el) => (el.style.display = 'flex'));
}

function hide(...els) {
  els.forEach((el) => (el.style.display = 'none'));
}

function setStatus(dotClass, label) {
  statusDot.className = `status-dot ${dotClass}`;
  statusText.textContent = label;
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
