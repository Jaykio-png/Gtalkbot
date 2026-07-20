/* ================================================================
   Campaign Studio — tab "Lộ trình" (soạn) + tab "Chạy & Gửi"
   ================================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
    return r.json();
  };
  const esc = (s) => { const e = document.createElement('span'); e.textContent = s == null ? '' : s; return e.innerHTML; };

  // Tải file ảnh từ máy -> server -> điền ref vào ô URL
  async function uploadFile(file, urlInput, statusEl) {
    if (!file) return;
    statusEl.textContent = '⏳ đang tải...';
    try {
      const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      const out = await api('/api/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, base64 }) });
      urlInput.value = out.ref;
      statusEl.textContent = `✓ ${file.name} (${out.width}×${out.height})`;
    } catch (e) { statusEl.textContent = '✗ ' + e.message; }
  }

  const state = { campaigns: [], facets: { titles: [], divisions: [], departments: [] }, editingId: null };

  /* ---------- Tab wiring ---------- */
  $('tabCampaigns').addEventListener('click', () => switchTab('campaigns'));
  $('tabRun').addEventListener('click', () => switchTab('run'));
  $('tabQuick').addEventListener('click', () => switchTab('quick'));
  $('tabData').addEventListener('click', () => switchTab('data'));
  document.addEventListener('tabchange', (e) => {
    if (e.detail === 'campaigns') loadComposer();
    if (e.detail === 'run') loadRunStatus();
    if (e.detail === 'data') loadDataset();
  });

  /* ---------- Sub-tab wiring ---------- */
  document.querySelectorAll('.cmp-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.subtab;
      // Toggle active on buttons
      document.querySelectorAll('.cmp-subtab').forEach((b) => b.classList.toggle('active', b.dataset.subtab === target));
      // Toggle panels
      document.querySelectorAll('.cmp-subpanel').forEach((p) => { p.hidden = p.dataset.subtab !== target; });
    });
  });

  /* ================= COMPOSER ================= */
  async function loadComposer() {
    try {
      const [campaigns, facets] = await Promise.all([api('/api/campaigns'), api('/api/facets')]);
      state.campaigns = campaigns;
      state.facets = facets;
      renderList();
      if (state.editingId == null && campaigns.length) openEditor(campaigns[0].id);
      else if (state.editingId == null) $('cmpEditor').hidden = true;
    } catch (err) { alert('Lỗi tải lộ trình: ' + err.message); }
  }

  function renderList() {
    const ul = $('cmpList');
    ul.innerHTML = state.campaigns.map((c) => `
      <li class="cmp-list-item ${c.id === state.editingId ? 'active' : ''}" data-id="${esc(c.id)}">
        <span class="cmp-dot ${c.enabled === false ? 'off' : 'on'}"></span>
        <div class="cmp-li-body">
          <div class="cmp-li-name">${esc(c.name || '(chưa đặt tên)')}</div>
          <div class="cmp-li-sub">${(c.messages || []).length} mốc · ${audienceSummary(c.audience)}</div>
        </div>
      </li>`).join('') || '<li class="cmp-empty">Chưa có lộ trình nào.</li>';
    ul.querySelectorAll('.cmp-list-item').forEach((li) => li.addEventListener('click', () => openEditor(li.dataset.id)));
  }

  function audienceSummary(a = {}) {
    const parts = [];
    if (a.titles?.length) parts.push(`${a.titles.length} chức danh`);
    if (a.divisions?.length) parts.push(`${a.divisions.length} khối`);
    if (a.departments?.length) parts.push(`${a.departments.length} phòng ban`);
    return parts.length ? parts.join(' · ') : 'mọi đối tượng';
  }

  function fillMulti(sel, options, selected = []) {
    const set = new Set(selected.map((s) => String(s)));
    sel.innerHTML = options.map((o) => `<option value="${esc(o)}" ${set.has(String(o)) ? 'selected' : ''}>${esc(o)}</option>`).join('');
  }
  const getMulti = (sel) => [...sel.selectedOptions].map((o) => o.value);

  // ô tìm kiếm + badge đếm số đã chọn (gắn 1 lần)
  const countMap = { cmpTitles: 'cntTitles', cmpDivisions: 'cntDivisions', cmpDepartments: 'cntDepartments' };
  function updateCounts() {
    for (const [selId, cntId] of Object.entries(countMap)) {
      const n = document.getElementById(selId).selectedOptions.length;
      document.getElementById(cntId).textContent = n ? `· đã chọn ${n}` : '';
    }
  }
  document.querySelectorAll('.cmp-search').forEach((inp) => {
    inp.addEventListener('input', () => {
      const sel = document.getElementById(inp.dataset.target);
      const q = inp.value.trim().toLowerCase();
      [...sel.options].forEach((o) => { o.hidden = q && !o.value.toLowerCase().includes(q); });
    });
  });
  Object.keys(countMap).forEach((id) => document.getElementById(id).addEventListener('change', updateCounts));

  function openEditor(id) {
    const c = state.campaigns.find((x) => String(x.id) === String(id));
    if (!c) return;
    state.editingId = c.id;
    renderList();
    $('cmpEditor').hidden = false;
    $('cmpName').value = c.name || '';
    $('cmpEnabled').checked = c.enabled !== false;
    $('cmpAnchor').value = c.anchorMode === 'campaign' ? 'campaign' : 'tenure';
    $('cmpStartDate').value = (c.startDate || '').slice(0, 10);
    $('cmpEnrollFrom').value = (c.enrollFrom || '').slice(0, 10);
    $('cmpTargetIds').value = (c.targetIds || []).join(', ');
    $('cmpParseMode').value = c.parseMode || 'PLAIN_TEXT';
    $('cmpSendTime').value = c.sendTime || '';
    toggleStartDate();
    fillMulti($('cmpTitles'), state.facets.titles, c.audience?.titles || []);
    fillMulti($('cmpDivisions'), state.facets.divisions, c.audience?.divisions || []);
    fillMulti($('cmpDepartments'), state.facets.departments, c.audience?.departments || []);
    document.querySelectorAll('.cmp-search').forEach((i) => (i.value = ''));
    updateCounts();
    renderMessages(c.messages || []);
    $('cmpSavedMsg').hidden = true;

    // Reset sub-tab to "Đối tượng"
    document.querySelectorAll('.cmp-subtab').forEach((b) => b.classList.toggle('active', b.dataset.subtab === 'audience'));
    document.querySelectorAll('.cmp-subpanel').forEach((p) => { p.hidden = p.dataset.subtab !== 'audience'; });
  }

  function renderMessages(messages) {
    const wrap = $('cmpMessages');
    wrap.innerHTML = '';
    messages.forEach((m) => wrap.appendChild(messageRow(m.day, m.text, m.imageUrl)));
    if (!messages.length) wrap.appendChild(messageRow('', '', ''));
  }

  function messageRow(day, text, imageUrl) {
    const row = document.createElement('div');
    row.className = 'cmp-msg-row';
    row.innerHTML = `
      <div class="cmp-msg-day">
        <label>Ngày</label>
        <input type="number" class="cmp-day-input" min="0" value="${day === '' ? '' : Number(day)}">
      </div>
      <div class="cmp-msg-main">
        <textarea class="cmp-msg-text" rows="2" placeholder="Nội dung tin / caption ảnh...">${esc(text)}</textarea>
        <div class="cmp-img-row">
          <input type="text" class="cmp-msg-img" placeholder="🖼️ URL ảnh, hoặc bấm Tải ảnh →" value="${esc(imageUrl || '')}">
          <label class="cmp-upload-btn">📎 Tải ảnh<input type="file" accept="image/png,image/jpeg,image/gif" class="cmp-file" hidden></label>
          <span class="cmp-img-status"></span>
        </div>
      </div>
      <button class="cmp-msg-del" title="Xóa mốc" type="button">✕</button>`;
    row.querySelector('.cmp-msg-del').addEventListener('click', () => row.remove());
    row.querySelector('.cmp-file').addEventListener('change', (e) => uploadFile(e.target.files[0], row.querySelector('.cmp-msg-img'), row.querySelector('.cmp-img-status')));
    return row;
  }

  function toggleStartDate() {
    const isCampaign = $('cmpAnchor').value === 'campaign';
    $('cmpStartDateWrap').hidden = !isCampaign;
    // enrollFrom chỉ có nghĩa ở chế độ thâm niên (cuốn chiếu theo ngày vào làm)
    const ef = $('cmpEnrollFromWrap');
    if (ef) ef.hidden = isCampaign;
  }
  $('cmpAnchor').addEventListener('change', toggleStartDate);

  $('cmpAddMsg').addEventListener('click', () => $('cmpMessages').appendChild(messageRow('', '')));

  $('cmpNewBtn').addEventListener('click', () => {
    const c = { id: 'cmp_' + Date.now(), name: '', enabled: true, anchorMode: 'tenure', startDate: '', enrollFrom: '', targetIds: [], parseMode: 'PLAIN_TEXT', audience: { titles: [], divisions: [], departments: [], includeOff: false }, messages: [] };
    state.campaigns.push(c);
    openEditor(c.id);
    $('cmpName').focus();
  });

  $('cmpDeleteBtn').addEventListener('click', async () => {
    if (!state.editingId) return;
    if (!confirm('Xóa lộ trình này?')) return;
    state.campaigns = state.campaigns.filter((c) => c.id !== state.editingId);
    state.editingId = null;
    await persist();
    renderList();
    $('cmpEditor').hidden = true;
  });

  $('cmpSaveBtn').addEventListener('click', async () => {
    const c = state.campaigns.find((x) => x.id === state.editingId);
    if (!c) return;
    c.name = $('cmpName').value.trim();
    c.enabled = $('cmpEnabled').checked;
    c.anchorMode = $('cmpAnchor').value;
    c.startDate = c.anchorMode === 'campaign' ? ($('cmpStartDate').value || '') : '';
    c.enrollFrom = c.anchorMode === 'tenure' ? ($('cmpEnrollFrom').value || '') : '';
    c.targetIds = parseIds($('cmpTargetIds').value);
    c.parseMode = $('cmpParseMode').value;
    c.sendTime = /^([01]\d|2[0-3]):[0-5]\d$/.test($('cmpSendTime').value) ? $('cmpSendTime').value : '';
    c.audience = {
      titles: getMulti($('cmpTitles')),
      divisions: getMulti($('cmpDivisions')),
      departments: getMulti($('cmpDepartments')),
      includeOff: false,
    };
    c.messages = [...$('cmpMessages').querySelectorAll('.cmp-msg-row')]
      .map((r) => ({ day: parseInt(r.querySelector('.cmp-day-input').value, 10), text: r.querySelector('.cmp-msg-text').value.trim(), imageUrl: r.querySelector('.cmp-msg-img').value.trim() }))
      .filter((m) => Number.isFinite(m.day) && (m.text || m.imageUrl))
      .sort((a, b) => a.day - b.day);
    await persist();
    renderList();
    const msg = $('cmpSavedMsg'); msg.hidden = false; setTimeout(() => (msg.hidden = true), 2000);
  });

  async function persist() {
    await api('/api/campaigns', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.campaigns) });
  }

  /* ================= RUN & SEND ================= */
  let lastPreviewSends = []; // store for filtering

  async function loadRunStatus() {
    try {
      const s = await api('/api/status');
      const runs = s.scanStats?.runsToday ? ` · ${s.scanStats.runsToday} lượt` : '';
      $('runStatus').innerHTML = `
        <span class="run-pill">Môi trường: <b>${esc(s.env)}</b></span>
        <span class="run-pill">Roster: <b>${s.rosterSize}</b> NV</span>
        <span class="run-pill">ID mới nhất đã quét: <b>${s.lastMaxId ?? '—'}</b></span>
        <span class="run-pill">Cửa sổ: <b>≤ ${s.maxTenureDays} ngày</b></span>
        <span class="run-pill">Lộ trình: <b>${s.campaignCount}</b></span>
        <span class="run-pill">🔄 Crawl hôm nay: <b>${s.crawledToday ?? 0}</b> NV mới${runs}</span>`;
    } catch (err) { $('runStatus').textContent = 'Lỗi tải trạng thái: ' + err.message; }
  }

  /* ================= BỘ DỮ LIỆU: 2 luồng crawl + danh sách ================= */
  const fmtDate = (s) => { if (!s || s === '0001-01-01T00:00:00Z') return '—'; const d = new Date(s); return isNaN(d.getTime()) ? s : d.toLocaleDateString('vi-VN'); };
  let crawlPoll = null;

  async function pollCrawl() {
    try {
      const c = await api('/api/crawl-status');
      const msg = $('dataCrawlMsg'); msg.hidden = false;
      if (c.running) { msg.textContent = (c.mode === 'seed' ? '🌱 Đang seed (crawl lùi)' : '🔄 Đang crawl tiến') + '...'; return; }
      clearInterval(crawlPoll); crawlPoll = null;
      setLoading($('dataSeedBtn'), false); setLoading($('dataCrawlBtn'), false);
      if (c.error) {
        msg.textContent = '❌ Lỗi: ' + c.error;
      } else {
        const n = c.scanStats?.lastRunFound ?? 0;
        msg.textContent = `✓ Xong (${c.mode === 'seed' ? 'seed' : 'tiến'}): +${n} NV mới (hôm nay tổng ${c.scanStats?.foundToday ?? n}).`;
      }
      loadDataset();
    } catch { /* tiếp tục poll */ }
  }

  function startCrawlFlow(endpoint, btn, payload = {}) {
    if (crawlPoll) return;
    setLoading(btn, true);
    const msg = $('dataCrawlMsg'); msg.hidden = false; msg.textContent = '⏳ Bắt đầu...';
    api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(() => { crawlPoll = setInterval(pollCrawl, 2000); })
      .catch((err) => { setLoading(btn, false); msg.textContent = '❌ ' + err.message; });
  }

  async function loadDataStatus() {
    try {
      const s = await api('/api/status');
      const ss = s.scanStats;
      const lastRun = ss?.lastRunAt ? new Date(ss.lastRunAt).toLocaleString('vi-VN') : '—';
      $('dataStatus').innerHTML = `
        <span class="run-pill">Bộ dữ liệu: <b>${s.rosterSize}</b> NV</span>
        <span class="run-pill">ID mới nhất: <b>${s.lastMaxId ?? '—'}</b></span>
        <span class="run-pill">🌱 Crawl hôm nay: <b>${s.crawledToday ?? 0}</b> NV mới${ss?.runsToday ? ` · ${ss.runsToday} lượt` : ''}</span>
        <span class="run-pill">Lần cuối: <b>${esc(lastRun)}</b>${ss?.lastMode ? ` (${ss.lastMode === 'seed' ? 'seed' : 'tiến'})` : ''}</span>`;
    } catch (err) { $('dataStatus').textContent = 'Lỗi tải trạng thái: ' + err.message; }
  }

  // ----- Bảng dữ liệu: lưu hàng + sort theo cột + phân trang -----
  let datasetRows = [];
  let dataSort = { key: 'workingDays', asc: true };
  let dataPage = 1;
  let dataPageSize = 50;
  const isActive = (p) => p.status === 1 || (p.status_text || '').includes('đang làm');
  const sortVal = (p, key) => {
    switch (key) {
      case 'dept': return (p.department || p.division || '').toLowerCase();
      case 'active': return isActive(p) ? 1 : 0;
      case 'start_working_date': { const t = new Date(p.start_working_date).getTime(); return Number.isFinite(t) ? t : 0; }
      case 'full_name': case 'title_name': return String(p[key] || '').toLowerCase();
      default: return Number(p[key]) || 0; // workingDays, employee_id
    }
  };

  // Lọc theo các select; trả về danh sách đã lọc (chưa sort/phân trang)
  function filteredRows() {
    const fT = $('dataFilterTitle').value, fD = $('dataFilterDept').value, fS = $('dataFilterStatus').value, fDay = $('dataFilterDays').value;
    return datasetRows.filter((p) => {
      if (fT && (p.title_name || '') !== fT) return false;
      if (fD && (p.department || p.division || '') !== fD) return false;
      if (fS === 'active' && !isActive(p)) return false;
      if (fS === 'off' && isActive(p)) return false;
      if (fDay !== '' && String(p.workingDays ?? '') !== fDay) return false;
      return true;
    });
  }

  // Đổ tùy chọn cho các select lọc từ dữ liệu thực
  function populateDataFilters() {
    const fill = (sel, values) => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">Tất cả</option>' + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      if (values.map(String).includes(cur)) sel.value = cur;
    };
    const uniq = (arr) => [...new Set(arr)];
    fill($('dataFilterTitle'), uniq(datasetRows.map((p) => p.title_name).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'vi')));
    fill($('dataFilterDept'), uniq(datasetRows.map((p) => p.department || p.division).filter(Boolean)).sort((a, b) => a.localeCompare(b, 'vi')));
    fill($('dataFilterDays'), uniq(datasetRows.map((p) => p.workingDays).filter((v) => v != null)).sort((a, b) => a - b).map(String));
  }

  function renderDataRows() {
    const body = $('dataBody');
    // mũi tên chỉ hướng sort trên cột đang chọn
    document.querySelectorAll('#panelData th.col-sort').forEach((th) => {
      const a = th.querySelector('.sort-arrow');
      if (a) a.textContent = th.dataset.key === dataSort.key ? (dataSort.asc ? ' ▲' : ' ▼') : '';
    });
    if (!datasetRows.length) {
      body.innerHTML = '<tr class="no-results-row"><td colspan="8">Chưa có dữ liệu. Bấm “🌱 Seed base (lùi)” để bắt đầu.</td></tr>';
      $('dataCount').innerHTML = '';
      $('dataPageInfo').textContent = '';
      $('dataPrev').disabled = $('dataNext').disabled = true;
      return;
    }
    const base = filteredRows();
    const total = base.length;
    $('dataCount').innerHTML = total === datasetRows.length
      ? `<span class="count-num">${total}</span> NV`
      : `<span class="count-num">${total}</span> / ${datasetRows.length} NV`;
    if (!total) {
      body.innerHTML = '<tr class="no-results-row"><td colspan="8">Không có NV khớp bộ lọc.</td></tr>';
      $('dataPageInfo').textContent = '';
      $('dataPrev').disabled = $('dataNext').disabled = true;
      return;
    }
    const sorted = base.sort((a, b) => {
      const va = sortVal(a, dataSort.key), vb = sortVal(b, dataSort.key);
      const r = typeof va === 'string' ? va.localeCompare(vb, 'vi') : (va - vb);
      return dataSort.asc ? r : -r;
    });
    const pages = Math.max(1, Math.ceil(total / dataPageSize));
    if (dataPage > pages) dataPage = pages;
    const start = (dataPage - 1) * dataPageSize;
    const slice = sorted.slice(start, start + dataPageSize);
    body.innerHTML = slice.map((p, i) => {
      const active = isActive(p);
      return `<tr>
        <td>${start + i + 1}</td>
        <td class="td-days">${(p.workingDays ?? 0).toLocaleString('vi-VN')}</td>
        <td>${esc(p.full_name)}</td>
        <td>${esc(p.employee_id)}</td>
        <td>${esc(p.title_name || '—')}</td>
        <td>${esc(p.department || p.division || '—')}</td>
        <td>${fmtDate(p.start_working_date)}</td>
        <td><span class="table-status ${active ? 'active' : 'inactive'}">${active ? 'Đang LV' : 'Đã nghỉ'}</span></td>
      </tr>`;
    }).join('');
    $('dataPageInfo').textContent = `Trang ${dataPage}/${pages} · ${start + 1}–${start + slice.length} / ${total} NV`;
    $('dataPrev').disabled = dataPage <= 1;
    $('dataNext').disabled = dataPage >= pages;
  }

  // Bấm tiêu đề cột để sort; bấm lại đảo chiều (về trang 1)
  document.querySelectorAll('#panelData th.col-sort').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (dataSort.key === key) dataSort.asc = !dataSort.asc;
      else { dataSort.key = key; dataSort.asc = true; }
      dataPage = 1;
      renderDataRows();
    });
  });

  // Phân trang
  $('dataPageSize')?.addEventListener('change', (e) => { dataPageSize = parseInt(e.target.value, 10) || 50; dataPage = 1; renderDataRows(); });
  $('dataPrev')?.addEventListener('click', () => { if (dataPage > 1) { dataPage--; renderDataRows(); } });
  $('dataNext')?.addEventListener('click', () => { dataPage++; renderDataRows(); });

  // Lọc (xổ xuống) — đổi là về trang 1
  ['dataFilterTitle', 'dataFilterDept', 'dataFilterStatus', 'dataFilterDays'].forEach((id) => {
    $(id)?.addEventListener('change', () => { dataPage = 1; renderDataRows(); });
  });
  $('dataClearFilters')?.addEventListener('click', () => {
    ['dataFilterTitle', 'dataFilterDept', 'dataFilterStatus', 'dataFilterDays'].forEach((id) => { $(id).value = ''; });
    dataPage = 1; renderDataRows();
  });

  async function loadDataset() {
    loadDataStatus();
    loadSchedule();
    const body = $('dataBody');
    body.innerHTML = '<tr><td colspan="8">Đang tải...</td></tr>';
    try {
      const d = await api('/api/dataset');
      datasetRows = d.employees || [];
      dataPage = 1;
      populateDataFilters();
      renderDataRows();
    } catch (err) { body.innerHTML = `<tr><td colspan="8">Lỗi: ${esc(err.message)}</td></tr>`; }
  }

  // ----- Lịch tự động (scheduler nội bộ) -----
  async function loadSchedule() {
    try {
      const s = await api('/api/schedule');
      $('schCrawlEnabled').checked = !!s.crawlEnabled;
      $('schCrawlTime').value = s.crawlTime || '07:00';
    } catch { /* để mặc định */ }
  }
  $('schSaveBtn')?.addEventListener('click', async () => {
    const payload = { crawlEnabled: $('schCrawlEnabled').checked, crawlTime: $('schCrawlTime').value };
    $('schMsg').textContent = '⏳ đang lưu...';
    try {
      const r = await api('/api/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const c = r.schedule;
      $('schMsg').textContent = `✓ Đã lưu — tự crawl ${c.crawlEnabled ? c.crawlTime + ' (tiến)' : 'tắt'}. Bắn Bot theo giờ từng lộ trình.`;
    } catch (err) { $('schMsg').textContent = '❌ ' + err.message; }
  });

  $('dataSeedBtn')?.addEventListener('click', () => {
    const fromId = parseInt($('dataSeedId').value, 10);
    if (!Number.isFinite(fromId) || fromId <= 0) { alert('Nhập "ID mới nhất" trước khi Seed nhé.'); $('dataSeedId').focus(); return; }
    if (!confirm(`Seed sẽ crawl LÙI từ ID ${fromId} để lấy base NV mới (thâm niên 1 ngày), quét tối đa 500 ID. Thường chỉ chạy 1 lần. Tiếp tục?`)) return;
    startCrawlFlow('/api/seed', $('dataSeedBtn'), { fromId });
  });
  $('dataCrawlBtn')?.addEventListener('click', () => startCrawlFlow('/api/crawl', $('dataCrawlBtn')));
  $('dataRefreshBtn')?.addEventListener('click', () => loadDataset());

  let lastPreviewCount = 0;
  const setLoading = (btn, on) => { btn.classList.toggle('loading', on); btn.disabled = on; };

  $('runPreviewBtn').addEventListener('click', () => doRun('/api/preview', false));
  $('runSendBtn').addEventListener('click', () => {
    if (!confirm(`Gửi thật ${lastPreviewCount} tin nhắn qua GTalk?`)) return;
    doRun('/api/run', true);
  });

  async function doRun(url, isSend) {
    const btn = isSend ? $('runSendBtn') : $('runPreviewBtn');
    setLoading(btn, true);
    $('runError').hidden = true;
    try {
      const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      renderRunResult(r, isSend);
      loadRunStatus();
    } catch (err) {
      $('runErrorText').textContent = err.message;
      $('runError').hidden = false;
    } finally { setLoading(btn, false); }
  }

  function renderRunResult(r, isSend) {
    const sends = r.sends || [];
    lastPreviewSends = sends;
    lastPreviewCount = sends.length;
    $('runSendBtn').disabled = sends.length === 0;

    $('runResultSection').hidden = false;
    if (isSend) {
      $('runResultTitle').textContent = '📤 Đã gửi';
      $('runCount').innerHTML = `<span class="count-num">${r.sent?.length || 0}</span> gửi OK · ${r.errors?.length || 0} lỗi/bỏ qua`;
    } else {
      $('runResultTitle').textContent = '👀 Xem trước hôm nay';
      $('runCount').innerHTML = `<span class="count-num">${sends.length}</span> tin sẽ gửi`;
    }

    // Build campaign filter dropdown
    const filter = $('runCampaignFilter');
    const campaignNames = [...new Set(sends.map((s) => s.campaignName))].sort();
    filter.innerHTML = '<option value="">Tất cả lộ trình</option>' +
      campaignNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

    // Render grouped
    renderGroupedResults(sends, isSend);
  }

  function renderGroupedResults(sends, isSend) {
    const container = $('runGroupedBody');

    if (sends.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--clr-text-muted);font-style:italic;">Hôm nay không có nhân viên nào trúng mốc trong các lộ trình đang bật.</div>';
      return;
    }

    // Group by campaignName
    const groups = {};
    sends.forEach((s) => {
      const key = s.campaignName || '(Không rõ)';
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });

    let html = '';
    let idx = 0;
    for (const [name, items] of Object.entries(groups)) {
      html += `
        <div class="run-campaign-group" data-campaign="${esc(name)}">
          <div class="run-campaign-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="run-campaign-chevron"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="run-campaign-name">${esc(name)}</span>
            <span class="run-campaign-count">${items.length} tin</span>
          </div>
          <div class="run-campaign-body">
            <table class="history-table">
              <thead><tr><th>#</th><th>Mốc</th><th>Họ tên</th><th>Employee ID</th><th>Chức danh</th><th>Nội dung</th></tr></thead>
              <tbody>`;
      items.forEach((s) => {
        idx++;
        html += `
                <tr>
                  <td>${idx}</td>
                  <td><span class="table-status active">ngày ${s.day}</span></td>
                  <td class="td-name">${esc(s.full_name)}</td>
                  <td>${s.employee_id}</td>
                  <td>${esc(s.title_name || '—')}</td>
                  <td class="td-msg">${esc(s.text)}</td>
                </tr>`;
      });
      html += `
              </tbody>
            </table>
          </div>
        </div>`;
    }
    container.innerHTML = html;
  }

  // Campaign filter in Run tab
  $('runCampaignFilter').addEventListener('change', () => {
    const val = $('runCampaignFilter').value;
    const groups = document.querySelectorAll('.run-campaign-group');
    groups.forEach((g) => {
      g.style.display = (!val || g.dataset.campaign === val) ? '' : 'none';
    });
    // Update count
    const visible = val ? lastPreviewSends.filter((s) => s.campaignName === val).length : lastPreviewSends.length;
    $('runCount').innerHTML = `<span class="count-num">${visible}</span> tin sẽ gửi`;
  });

  /* ================= GỬI NGAY ================= */
  const parseIds = (raw) => [...new Set((raw.match(/\d+/g) || []).map(Number))];

  $('qsFile').addEventListener('change', (e) => uploadFile(e.target.files[0], $('qsImg'), $('qsImgStatus')));
  $('qsIds').addEventListener('input', () => {
    const n = parseIds($('qsIds').value).length;
    $('qsIdCount').textContent = n ? `${n} ID hợp lệ` : '';
  });

  let qsLastCount = 0;
  $('qsFailCopy').addEventListener('click', () => {
    const ta = $('qsFailIds');
    ta.select();
    navigator.clipboard?.writeText(ta.value).catch(() => {});
    const btn = $('qsFailCopy'); const old = btn.textContent;
    btn.textContent = '✓ Đã copy'; setTimeout(() => { btn.textContent = old; }, 1500);
  });
  $('qsPreviewBtn').addEventListener('click', () => doQuick('/api/quick-preview', false));
  $('qsSendBtn').addEventListener('click', () => {
    if (!confirm(`Gửi NGAY ${qsLastCount} tin nhắn qua GTalk?`)) return;
    doQuick('/api/quick-send', true);
  });

  async function doQuick(url, isSend) {
    const ids = parseIds($('qsIds').value);
    const text = $('qsText').value;
    const parseMode = $('qsParseMode').value;
    const imageUrl = $('qsImg').value.trim();
    if (!ids.length) return alert('Chưa có employee_id.');
    if (!text.trim() && !imageUrl) return alert('Chưa có nội dung hoặc URL ảnh.');
    const btn = isSend ? $('qsSendBtn') : $('qsPreviewBtn');
    const directFire = $('qsDirectFire').checked;
    const resume = $('qsResume') ? $('qsResume').checked : false;
    setLoading(btn, true);
    $('qsError').hidden = true;
    try {
      if (!isSend) {
        const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, text, parseMode, imageUrl, directFire }) });
        renderQuick(r, false);
      } else {
        // Gửi thật: chạy nền, poll tiến độ
        const { jobId } = await api('/api/quick-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, text, parseMode, imageUrl, directFire, resume }) });
        $('qsResultSection').hidden = false;
        let j;
        do {
          j = await api('/api/job?id=' + encodeURIComponent(jobId));
          renderJob(j);
          if (j.status === 'running') await new Promise((r) => setTimeout(r, 1000));
        } while (j.status === 'running');
      }
    } catch (err) { $('qsErrorText').textContent = err.message; $('qsError').hidden = false; }
    finally { setLoading(btn, false); }
  }

  function renderJob(j) {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    const statusTxt = j.status === 'done' ? '✅ XONG' : j.status === 'error' ? ('❌ ' + esc(j.error || 'lỗi')) : ('⏳ đang gửi: ' + esc(j.current || ''));
    $('qsResultTitle').textContent = '📤 Tiến độ gửi';
    $('qsCount').innerHTML = `
      <div style="min-width:340px">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:var(--fs-xs);margin-bottom:4px">
          <span><b>${j.done}/${j.total}</b> (${pct}%) · ✓${j.ok} ↻${j.skipped} ✗${j.failed}</span>
          <span>${statusTxt}</span>
        </div>
        <div style="height:8px;background:var(--clr-surface-elevated);border-radius:99px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:var(--clr-accent);transition:width .3s"></div>
        </div>
      </div>`;
    const rows = (j.items || []).slice().reverse(); // mới nhất lên trên
    $('qsBody').innerHTML = rows.map((it, i) => {
      const st = it.status === 'ok' ? '<span class="table-status active">đã gửi ✓</span>'
        : it.status === 'skipped' ? '<span class="table-status">↻ bỏ qua (đã gửi)</span>'
        : it.status === 'notfound' ? '<span class="table-status inactive">không tìm thấy</span>'
        : `<span class="table-status inactive">✗ ${esc(it.error || 'lỗi')}</span>`;
      return `<tr><td>${rows.length - i}</td><td>${it.employee_id}</td><td class="td-name">${esc(it.name || '')}</td><td>—</td><td>${st}</td><td class="td-msg"></td></tr>`;
    }).join('');
    renderFailSummary((j.items || [])
      .filter((it) => it.status === 'error')
      .map((it) => ({ employee_id: it.employee_id, name: it.name, error: it.error })));
  }

  // Bảng tổng hợp các ID gửi lỗi (đa số do tạo channel thất bại) — có nút copy để dán lại gửi lại.
  function renderFailSummary(fails) {
    const box = $('qsFailSummary');
    if (!box) return;
    if (!fails || !fails.length) { box.hidden = true; return; }
    box.hidden = false;
    const ids = fails.map((f) => f.employee_id);
    $('qsFailCount').textContent = fails.length;
    $('qsFailIds').value = ids.join(', ');
    // Gom theo loại lỗi để biết bao nhiêu ca là do tạo channel
    const byErr = {};
    fails.forEach((f) => { const k = (f.error || 'lỗi không rõ').trim(); (byErr[k] = byErr[k] || []).push(f.employee_id); });
    $('qsFailDetail').innerHTML = Object.entries(byErr)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([err, list]) => `<div>• <b>${list.length}</b> · ${esc(err)} <span style="opacity:.6">(${list.join(', ')})</span></div>`)
      .join('');
  }

  function renderQuick(r, isSend) {
    const items = r.items || [];
    const parseMode = $('qsParseMode').value;
    qsLastCount = items.filter((it) => !it.notfound).length;
    $('qsSendBtn').disabled = qsLastCount === 0;
    $('qsResultSection').hidden = false;

    // Hiển thị nội dung tin nhắn: render HTML khi parseMode=HTML, escape khi khác
    const fmtMsg = (txt) => {
      if (parseMode === 'HTML') return `<div class="msg-html-preview">${txt}</div>`;
      return esc(txt);
    };

    if (isSend) {
      $('qsResultTitle').textContent = '⚡ Đã gửi';
      $('qsCount').innerHTML = `<span class="count-num">${r.sent?.length || 0}</span> gửi OK · ${r.errors?.length || 0} lỗi`;
      const okIds = new Set((r.sent || []).map((s) => s.employee_id));
      const errMap = {}; (r.errors || []).forEach((e) => (errMap[e.employee_id] = e.error));
      $('qsBody').innerHTML = items.map((it, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${it.employee_id}</td>
          <td class="td-name">${esc(it.full_name)}</td>
          <td>${esc(it.title_name || '—')}</td>
          <td>${okIds.has(it.employee_id) ? '<span class="table-status active">đã gửi ✓</span>' : `<span class="table-status inactive">${esc(errMap[it.employee_id] || 'lỗi')}</span>`}</td>
          <td class="td-msg">${fmtMsg(it.text)}</td>
        </tr>`).join('');
      renderFailSummary((r.errors || []).map((e) => ({ employee_id: e.employee_id, name: e.full_name, error: e.error })));
    } else {
      const modeBadge = parseMode === 'HTML' ? '🔤 HTML' : parseMode === 'MARKDOWN' ? '🔤 Markdown' : '🔤 Text';
      const fireBadge = r.directFire ? ' · ⚡ Bắn thẳng' : '';
      $('qsResultTitle').textContent = '👀 Xem trước';
      $('qsCount').innerHTML = `<span class="count-num">${qsLastCount}</span> sẽ gửi · ${items.length - qsLastCount} không tìm thấy <small style="opacity:.6">${modeBadge}${fireBadge}</small>`;
      $('qsBody').innerHTML = items.map((it, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${it.employee_id}</td>
          <td class="td-name">${esc(it.full_name)}</td>
          <td>${esc(it.title_name || '—')}</td>
          <td>${it.notfound ? '<span class="table-status inactive">không tìm thấy</span>' : (it.active ? '<span class="table-status active">đang LV</span>' : '<span class="table-status inactive">đã nghỉ</span>')}</td>
          <td class="td-msg">${fmtMsg(it.text)}</td>
        </tr>`).join('');
      renderFailSummary([]); // xem trước: chưa gửi nên ẩn bảng lỗi
    }
  }
})();
