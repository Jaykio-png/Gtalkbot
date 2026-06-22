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
  document.addEventListener('tabchange', (e) => {
    if (e.detail === 'campaigns') loadComposer();
    if (e.detail === 'run') loadRunStatus();
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
    $('cmpTargetIds').value = (c.targetIds || []).join(', ');
    $('cmpParseMode').value = c.parseMode || 'PLAIN_TEXT';
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

  function toggleStartDate() { $('cmpStartDateWrap').hidden = $('cmpAnchor').value !== 'campaign'; }
  $('cmpAnchor').addEventListener('change', toggleStartDate);

  $('cmpAddMsg').addEventListener('click', () => $('cmpMessages').appendChild(messageRow('', '')));

  $('cmpNewBtn').addEventListener('click', () => {
    const c = { id: 'cmp_' + Date.now(), name: '', enabled: true, anchorMode: 'tenure', startDate: '', targetIds: [], parseMode: 'PLAIN_TEXT', audience: { titles: [], divisions: [], departments: [], includeOff: false }, messages: [] };
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
    c.targetIds = parseIds($('cmpTargetIds').value);
    c.parseMode = $('cmpParseMode').value;
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
      $('runStatus').innerHTML = `
        <span class="run-pill">Môi trường: <b>${esc(s.env)}</b></span>
        <span class="run-pill">Roster: <b>${s.rosterSize}</b> NV</span>
        <span class="run-pill">ID mới nhất đã quét: <b>${s.lastMaxId ?? '—'}</b></span>
        <span class="run-pill">Cửa sổ: <b>≤ ${s.maxTenureDays} ngày</b></span>
        <span class="run-pill">Lộ trình: <b>${s.campaignCount}</b></span>`;
    } catch (err) { $('runStatus').textContent = 'Lỗi tải trạng thái: ' + err.message; }
  }

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
    }
  }
})();
