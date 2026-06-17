/**
 * GHN Employee Lookup - App Logic
 * Tab 1: Single lookup  |  Tab 2: Batch scan with filters
 */

const CONFIG = {
  MCP_ENDPOINT: 'https://ws-mcpgateway.ghn.vn/mcp',
  API_KEY: 'mcp_692543e1bc3f5d4679228bec177af021c3350946e70f7ea3',
  PROTOCOL_VERSION: '2025-06-18',
};

/* ======== State ======== */
const state = {
  sessionId: null,
  connected: false,
  // Batch
  batchResults: [],       // { profile, workingDays }
  batchRunning: false,
  batchAbort: null,       // AbortController
  sortAsc: true,
};

/* ======== DOM ======== */
const dom = {
  // Connection
  connectionStatus: document.getElementById('connectionStatus'),
  // Tabs
  tabSingle: document.getElementById('tabSingle'),
  tabBatch: document.getElementById('tabBatch'),
  panelSingle: document.getElementById('panelSingle'),
  panelBatch: document.getElementById('panelBatch'),
  // Single lookup
  searchInput: document.getElementById('searchInput'),
  searchBtn: document.getElementById('searchBtn'),
  includeOffToggle: document.getElementById('includeOffToggle'),
  errorMessage: document.getElementById('errorMessage'),
  errorText: document.getElementById('errorText'),
  resultSection: document.getElementById('resultSection'),
  resultAvatar: document.getElementById('resultAvatar'),
  resultName: document.getElementById('resultName'),
  resultTitle: document.getElementById('resultTitle'),
  resultStatus: document.getElementById('resultStatus'),
  infoEmployeeId: document.getElementById('infoEmployeeId'),
  infoCandidateCode: document.getElementById('infoCandidateCode'),
  infoOrg: document.getElementById('infoOrg'),
  infoPhone: document.getElementById('infoPhone'),
  infoWorkEmail: document.getElementById('infoWorkEmail'),
  infoInternalEmail: document.getElementById('infoInternalEmail'),
  infoStartDate: document.getElementById('infoStartDate'),
  infoLeaveDate: document.getElementById('infoLeaveDate'),
  infoWorkingDays: document.getElementById('infoWorkingDays'),
  leaveDateItem: document.getElementById('leaveDateItem'),
  // Batch
  batchFrom: document.getElementById('batchFrom'),
  batchTo: document.getElementById('batchTo'),
  batchIncludeOff: document.getElementById('batchIncludeOff'),
  batchStartBtn: document.getElementById('batchStartBtn'),
  batchStopBtn: document.getElementById('batchStopBtn'),
  batchProgress: document.getElementById('batchProgress'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  progressFound: document.getElementById('progressFound'),
  batchError: document.getElementById('batchError'),
  batchErrorText: document.getElementById('batchErrorText'),
  batchResultSection: document.getElementById('batchResultSection'),
  batchBody: document.getElementById('batchBody'),
  batchSortBtn: document.getElementById('batchSortBtn'),
  batchExportBtn: document.getElementById('batchExportBtn'),
  batchClearBtn: document.getElementById('batchClearBtn'),
  // Filters
  filterTitle: document.getElementById('filterTitle'),
  filterDaysMin: document.getElementById('filterDaysMin'),
  filterDaysMax: document.getElementById('filterDaysMax'),
  clearFiltersBtn: document.getElementById('clearFiltersBtn'),
  filterCount: document.getElementById('filterCount'),
  thWorkingDays: document.getElementById('thWorkingDays'),
};


/* ================================================================
   MCP Transport (via local proxy)
   ================================================================ */

async function mcpRequest(method, params = {}, id = null) {
  const body = { jsonrpc: '2.0', method, params };
  if (id !== null) body.id = id;

  const headers = {
    'Content-Type': 'application/json',
    'X-Mcp-Auth': CONFIG.API_KEY,
  };
  if (state.sessionId) headers['X-Mcp-Session-Id'] = state.sessionId;

  const resp = await fetch('/mcp-proxy', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const sid = resp.headers.get('x-mcp-session-id');
  if (sid) state.sessionId = sid;
  if (!resp.ok) throw new Error(`MCP ${resp.status} ${resp.statusText}`);

  const text = await resp.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new Error(data.error.message || 'MCP error');
      return data.result;
    }
  }
  try { return JSON.parse(text).result; } catch { return null; }
}


/* ================================================================
   MCP Session
   ================================================================ */

async function initMcpSession() {
  updateConnectionStatus('connecting');
  try {
    const result = await mcpRequest('initialize', {
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ghn-employee-lookup', version: '2.0.0' },
    }, 1);
    if (!result?.serverInfo) throw new Error('No serverInfo');
    await mcpRequest('notifications/initialized');
    state.connected = true;
    updateConnectionStatus('connected');
  } catch (err) {
    console.error('[MCP] Init failed:', err);
    state.connected = false;
    updateConnectionStatus('error');
  }
}

function updateConnectionStatus(s) {
  const el = dom.connectionStatus;
  const text = el.querySelector('.status-text');
  el.className = 'header-status';
  if (s === 'connecting') text.textContent = 'Đang kết nối...';
  else if (s === 'connected') { el.classList.add('connected'); text.textContent = 'Đã kết nối'; }
  else { el.classList.add('error'); text.textContent = 'Lỗi kết nối'; }
}


/* ================================================================
   Single Employee Lookup
   ================================================================ */

async function lookupEmployee(employeeId, includeOff = false) {
  const args = { employee_id: parseInt(employeeId, 10) };
  if (includeOff) args.include_off = true;

  const result = await mcpRequest('tools/call', {
    name: 'ghn_employee_lookup',
    arguments: args,
  }, Date.now());

  if (result?.content) {
    for (const item of result.content) {
      if (item.type === 'text') return JSON.parse(item.text);
    }
  }
  throw new Error('Unexpected response format');
}

async function handleSearch() {
  const raw = dom.searchInput.value.trim();
  if (!raw) { showError('Vui lòng nhập Employee ID'); return; }
  const id = parseInt(raw, 10);
  if (isNaN(id)) { showError('Employee ID phải là số'); return; }
  if (!state.connected) { showError('Chưa kết nối MCP Gateway'); return; }

  setSearchLoading(true);
  hideError();
  dom.resultSection.hidden = true;

  try {
    const data = await lookupEmployee(id, dom.includeOffToggle.checked);
    if (!data.found) { showError(`Không tìm thấy nhân viên: ${id}`); return; }
    displayResult(data.profile);
  } catch (err) {
    showError(`Lỗi: ${err.message}`);
  } finally {
    setSearchLoading(false);
  }
}

function displayResult(p) {
  const names = p.full_name.split(' ');
  dom.resultAvatar.textContent = names.length >= 2
    ? names[0][0] + names[names.length - 1][0]
    : names[0].substring(0, 2);

  dom.resultName.textContent = p.full_name;
  dom.resultTitle.textContent = p.title_name || 'Không có chức danh';

  const active = p.status === 1 || p.status_text?.toLowerCase().includes('working');
  dom.resultStatus.textContent = active ? 'Đang làm việc' : (p.status_text || 'Đã nghỉ');
  dom.resultStatus.className = `status-badge ${active ? 'active' : 'inactive'}`;

  dom.infoEmployeeId.textContent = p.employee_id;
  dom.infoCandidateCode.textContent = p.candidate_code || '—';
  dom.infoOrg.textContent = p.org || '—';
  dom.infoPhone.textContent = p.phone || '—';
  dom.infoWorkEmail.textContent = p.work_email || '—';
  dom.infoInternalEmail.textContent = p.internal_email || '—';
  dom.infoStartDate.textContent = formatDate(p.start_working_date);

  if (p.leave_date && p.leave_date !== '' && p.leave_date !== '0001-01-01T00:00:00Z') {
    dom.infoLeaveDate.textContent = formatDate(p.leave_date);
    dom.leaveDateItem.hidden = false;
  } else {
    dom.leaveDateItem.hidden = true;
  }

  dom.infoWorkingDays.textContent = `${calcWorkingDays(p).toLocaleString('vi-VN')} ngày`;
  dom.resultSection.hidden = false;
}

function showError(msg) { dom.errorText.textContent = msg; dom.errorMessage.hidden = false; }
function hideError() { dom.errorMessage.hidden = true; }
function setSearchLoading(on) {
  dom.searchBtn.classList.toggle('loading', on);
  dom.searchBtn.disabled = on;
  dom.searchInput.disabled = on;
}


/* ================================================================
   Batch Scan
   ================================================================ */

async function startBatchScan() {
  const from = parseInt(dom.batchFrom.value, 10);
  const to = parseInt(dom.batchTo.value, 10);
  const concurrency = 5;
  const includeOff = dom.batchIncludeOff.checked;

  if (isNaN(from) || isNaN(to) || from > to) {
    dom.batchErrorText.textContent = 'Khoảng ID không hợp lệ (Từ phải ≤ Đến)';
    dom.batchError.hidden = false;
    return;
  }

  if (to - from > 5000) {
    dom.batchErrorText.textContent = 'Khoảng quét tối đa 5000 ID. Vui lòng thu hẹp lại.';
    dom.batchError.hidden = false;
    return;
  }

  if (!state.connected) {
    dom.batchErrorText.textContent = 'Chưa kết nối MCP Gateway';
    dom.batchError.hidden = false;
    return;
  }

  // Reset
  dom.batchError.hidden = true;
  state.batchResults = [];
  state.batchRunning = true;
  state.batchAbort = new AbortController();

  // UI
  dom.batchStartBtn.classList.add('loading');
  dom.batchStartBtn.disabled = true;
  dom.batchStopBtn.hidden = false;
  dom.batchProgress.hidden = false;
  dom.batchResultSection.hidden = true;

  const total = to - from + 1;
  let completed = 0;
  let found = 0;

  const updateProgress = () => {
    const pct = Math.round((completed / total) * 100);
    dom.progressBar.style.width = `${pct}%`;
    dom.progressText.textContent = `${completed} / ${total} (${pct}%)`;
    dom.progressFound.textContent = `Tìm thấy: ${found}`;
  };
  updateProgress();

  // Build ID queue
  const ids = [];
  for (let i = from; i <= to; i++) ids.push(i);

  // Worker pool
  const scanOne = async (empId) => {
    if (state.batchAbort.signal.aborted) return;
    try {
      const data = await lookupEmployee(empId, true); // always fetch all, filter client-side
      if (data.found && data.profile) {
        const isActive = data.profile.status === 1 || data.profile.status_text?.toLowerCase().includes('working');
        if (!includeOff && !isActive) {
          // skip inactive employees when toggle is off
        } else {
          found++;
          state.batchResults.push({
            profile: data.profile,
            workingDays: calcWorkingDays(data.profile),
          });
          renderBatchResults();
        }
      }
    } catch {
      // Silently skip errors for individual IDs
    }
    completed++;
    updateProgress();
  };

  // Concurrency limiter
  let idx = 0;
  const next = async () => {
    while (idx < ids.length && !state.batchAbort.signal.aborted) {
      const currentId = ids[idx++];
      await scanOne(currentId);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => next());
  await Promise.all(workers);

  // Done
  state.batchRunning = false;
  dom.batchStartBtn.classList.remove('loading');
  dom.batchStartBtn.disabled = false;
  dom.batchStopBtn.hidden = true;

  if (state.batchResults.length > 0) {
    renderBatchResults();
  } else if (!state.batchAbort.signal.aborted) {
    dom.batchErrorText.textContent = `Không tìm thấy nhân viên nào trong khoảng ${from} – ${to}`;
    dom.batchError.hidden = false;
  }
}

function stopBatchScan() {
  if (state.batchAbort) state.batchAbort.abort();
  state.batchRunning = false;
  dom.batchStartBtn.classList.remove('loading');
  dom.batchStartBtn.disabled = false;
  dom.batchStopBtn.hidden = true;
}


/* ================================================================
   Batch Results Table + Filters
   ================================================================ */

function renderBatchResults() {
  if (state.batchResults.length === 0) {
    dom.batchResultSection.hidden = true;
    return;
  }
  dom.batchResultSection.hidden = false;

  updateTitleFilter();

  // Apply filters
  const titleFilter = dom.filterTitle.value;
  const daysMin = dom.filterDaysMin.value !== '' ? parseInt(dom.filterDaysMin.value, 10) : null;
  const daysMax = dom.filterDaysMax.value !== '' ? parseInt(dom.filterDaysMax.value, 10) : null;

  let filtered = [...state.batchResults];
  if (titleFilter) filtered = filtered.filter(e => e.profile.title_name === titleFilter);
  if (daysMin !== null) filtered = filtered.filter(e => e.workingDays >= daysMin);
  if (daysMax !== null) filtered = filtered.filter(e => e.workingDays <= daysMax);

  // Sort
  filtered.sort((a, b) => state.sortAsc ? a.workingDays - b.workingDays : b.workingDays - a.workingDays);

  // Sort icon
  const icon = dom.thWorkingDays.querySelector('.sort-icon');
  icon.className = `sort-icon ${state.sortAsc ? '' : 'desc'}`;

  // Count
  dom.filterCount.innerHTML = `<span class="count-num">${filtered.length}</span> / ${state.batchResults.length} kết quả`;

  if (filtered.length === 0) {
    dom.batchBody.innerHTML = '<tr class="no-results-row"><td colspan="8">Không có kết quả phù hợp với bộ lọc</td></tr>';
    return;
  }

  dom.batchBody.innerHTML = filtered.map((entry, idx) => {
    const p = entry.profile;
    const active = p.status === 1 || p.status_text?.toLowerCase().includes('working');
    return `<tr>
      <td>${idx + 1}</td>
      <td class="td-days">${entry.workingDays.toLocaleString('vi-VN')}</td>
      <td class="td-name">${esc(p.full_name)}</td>
      <td>${p.employee_id}</td>
      <td>${esc(p.candidate_code || '—')}</td>
      <td>${esc(p.title_name || '—')}</td>
      <td>${esc(p.org || '—')}</td>
      <td><span class="table-status ${active ? 'active' : 'inactive'}">${active ? 'Đang LV' : 'Đã nghỉ'}</span></td>
    </tr>`;
  }).join('');
}

function updateTitleFilter() {
  const current = dom.filterTitle.value;
  const titles = [...new Set(state.batchResults.map(e => e.profile.title_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  dom.filterTitle.innerHTML = '<option value="">Tất cả</option>' + titles.map(t => {
    const sel = t === current ? ' selected' : '';
    return `<option value="${esc(t)}"${sel}>${esc(t)}</option>`;
  }).join('');
}

function exportCSV() {
  if (state.batchResults.length === 0) return;
  const headers = ['Employee ID', 'Họ tên', 'MSNV', 'Chức danh', 'Phòng ban', 'SĐT', 'Email', 'Trạng thái', 'Ngày vào', 'Ngày nghỉ', 'Số ngày LV'];
  const rows = state.batchResults.map(e => {
    const p = e.profile;
    const active = p.status === 1 || p.status_text?.toLowerCase().includes('working');
    return [
      p.employee_id,
      p.full_name,
      p.candidate_code || '',
      p.title_name || '',
      p.org || '',
      p.phone || '',
      p.work_email || '',
      active ? 'Đang LV' : 'Đã nghỉ',
      formatDate(p.start_working_date),
      formatDate(p.leave_date),
      e.workingDays,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ghn_employees_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


/* ================================================================
   Tabs
   ================================================================ */

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(p => { p.hidden = p.dataset.tab !== tab; });
  document.dispatchEvent(new CustomEvent('tabchange', { detail: tab }));
}


/* ================================================================
   Helpers
   ================================================================ */

function calcWorkingDays(p) {
  const start = new Date(p.start_working_date);
  if (isNaN(start.getTime())) return 0;
  const end = (p.leave_date && p.leave_date !== '' && p.leave_date !== '0001-01-01T00:00:00Z')
    ? new Date(p.leave_date)
    : new Date();
  return Math.max(0, Math.floor((end - start) / 86400000));
}

function formatDate(s) {
  if (!s || s === '0001-01-01T00:00:00Z') return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function esc(s) { const el = document.createElement('span'); el.textContent = s; return el.innerHTML; }


/* ================================================================
   Event Listeners
   ================================================================ */

// Tabs
dom.tabSingle.addEventListener('click', () => switchTab('single'));
dom.tabBatch.addEventListener('click', () => switchTab('batch'));

// Single lookup
dom.searchBtn.addEventListener('click', handleSearch);
dom.searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSearch(); });

// Batch
dom.batchStartBtn.addEventListener('click', startBatchScan);
dom.batchStopBtn.addEventListener('click', stopBatchScan);
dom.batchClearBtn.addEventListener('click', () => { state.batchResults = []; renderBatchResults(); dom.batchProgress.hidden = true; });
dom.batchExportBtn.addEventListener('click', exportCSV);

// Sort
dom.batchSortBtn.addEventListener('click', () => { state.sortAsc = !state.sortAsc; renderBatchResults(); });
dom.thWorkingDays.addEventListener('click', () => { state.sortAsc = !state.sortAsc; renderBatchResults(); });

// Filters
dom.filterTitle.addEventListener('change', renderBatchResults);
dom.filterDaysMin.addEventListener('input', renderBatchResults);
dom.filterDaysMax.addEventListener('input', renderBatchResults);
dom.clearFiltersBtn.addEventListener('click', () => {
  dom.filterTitle.value = '';
  dom.filterDaysMin.value = '';
  dom.filterDaysMax.value = '';
  renderBatchResults();
});


/* ================================================================
   Init
   ================================================================ */
initMcpSession();
