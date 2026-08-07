/* ================================================================
   Tab "Sơ đồ tổ chức" — danh bạ dim_employee kéo qua Data API (Trino)

   Dữ liệu nằm ở server (cache ~22.6k NV), tab này chỉ hỏi từng trang —
   không tải cả bảng xuống trình duyệt.
   ================================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`);
    return r.json();
  };
  const esc = (s) => { const e = document.createElement('span'); e.textContent = s == null ? '' : s; return e.innerHTML; };

  const state = { page: 1, pageSize: 50, total: 0, pages: 1, loaded: false, polling: null };

  /* ---------- Tab wiring ---------- */
  $('tabOrg').addEventListener('click', () => switchTab('org'));
  document.addEventListener('tabchange', (e) => {
    if (e.detail !== 'org') { stopPolling(); return; }
    openSub(currentSub());
  });

  /* ---------- Sub-tab wiring ----------
     Chỉ đụng .org-subtab/.org-subpanel TRONG #panelOrg — campaigns.js có handler
     riêng bắt mọi .cmp-subtab toàn trang, trộn class vào là hai bên tắt lẫn nhau. */
  const panel = $('panelOrg');
  const currentSub = () => (panel.querySelector('.org-subtab.active') || {}).dataset?.subtab || 'dir';

  function openSub(name) {
    panel.querySelectorAll('.org-subtab').forEach((b) => b.classList.toggle('active', b.dataset.subtab === name));
    panel.querySelectorAll('.org-subpanel').forEach((p) => { p.hidden = p.dataset.subtab !== name; });
    if (name === 'dir') {
      refreshStatus();
      if (!state.loaded) { loadFacets(); loadTree(); loadList(); state.loaded = true; }
    } else {
      stopPolling();
      loadDaily();
    }
  }
  panel.querySelectorAll('.org-subtab').forEach((b) => b.addEventListener('click', () => openSub(b.dataset.subtab)));

  /* ---------- Trạng thái + đồng bộ ---------- */
  const fmtWhen = (iso) => {
    if (!iso) return 'chưa đồng bộ lần nào';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  // .run-status là flex container chứa các chip .run-pill — mỗi ý một chip,
  // đừng nhét text/<br> vào thẳng (flex sẽ tách từng thẻ con thành 1 ô riêng, chữ nhảy loạn).
  const pill = (html) => `<span class="run-pill">${html}</span>`;

  async function refreshStatus() {
    const box = $('orgStatus');
    try {
      const s = await api('/api/org/status');
      if (!s.configured) {
        box.innerHTML = pill('⚠️ Chưa cấu hình <b>DATA_API_TOKEN</b> trên máy chủ');
        $('orgSyncBtn').disabled = true;
        $('orgPingBtn').disabled = true;
        return;
      }
      $('orgSyncBtn').disabled = !!s.sync.running;
      const sync = s.sync || {};
      const pills = [
        pill(`📚 Cache <b>${(s.count || 0).toLocaleString('vi-VN')}</b> nhân viên${s.includeOff ? ' (cả đã nghỉ)' : ' (đang làm)'}`),
        pill(`🕒 Cập nhật <b>${esc(fmtWhen(s.updatedAt))}</b>`),
      ];
      if (sync.running) {
        pills.push(pill(`⏳ Đang đồng bộ — đã lấy <b>${(sync.rows || 0).toLocaleString('vi-VN')}</b> dòng`));
        startPolling();
      } else if (sync.error) {
        pills.push(pill(`❌ Lỗi: <b>${esc(sync.error)}</b>`));
      } else if (sync.finishedAt) {
        pills.push(pill('✅ Đồng bộ xong'));
      }
      if (sync.quotaRemaining != null) pills.push(pill(`🎟️ Quota còn <b>${sync.quotaRemaining}</b> lượt hôm nay`));
      box.innerHTML = pills.join('');
    } catch (err) {
      box.innerHTML = pill('Lỗi tải trạng thái: ' + esc(err.message));
    }
  }

  // Đang sync thì poll để cập nhật số dòng; xong thì tự nạp lại bảng + cây.
  function startPolling() {
    if (state.polling) return;
    state.polling = setInterval(async () => {
      try {
        const s = await api('/api/org/status');
        if (!s.sync.running) {
          stopPolling();
          // Nút đang ở trạng thái quay — phải tự tắt, không thì nó quay mãi sau khi xong
          busy($('orgSyncBtn'), false);
          const msg = $('orgSyncMsg');
          msg.hidden = false;
          msg.textContent = s.sync.error
            ? '❌ ' + s.sync.error
            : `✅ Xong — ${(s.sync.rows || 0).toLocaleString('vi-VN')} nhân viên.`;
          await refreshStatus();
          await Promise.all([loadFacets(), loadTree(), loadList()]);
        } else {
          $('orgStatus').innerHTML = `⏳ Đang đồng bộ... đã lấy <b>${(s.sync.rows || 0).toLocaleString('vi-VN')}</b> dòng`;
        }
      } catch { /* mạng chớp — lần poll sau thử lại */ }
    }, 2000);
  }
  function stopPolling() { if (state.polling) { clearInterval(state.polling); state.polling = null; } }

  const busy = (btn, on) => { btn.disabled = on; btn.classList.toggle('loading', on); };

  $('orgPingBtn').addEventListener('click', async () => {
    const btn = $('orgPingBtn'), msg = $('orgSyncMsg');
    busy(btn, true);
    msg.hidden = false;
    msg.textContent = '📡 Đang thử gọi...';
    try {
      const r = await api('/api/org/ping', { method: 'POST' });
      msg.innerHTML = (r.reachable && r.authorized ? '✅ ' : r.reachable ? '⚠️ ' : '❌ ')
        + esc(r.detail) + ` <small>(${r.ms}ms)</small>`;
    } catch (err) { msg.textContent = '❌ ' + err.message; }
    busy(btn, false);
  });

  $('orgSyncBtn').addEventListener('click', async () => {
    const includeOff = $('orgIncludeOff').checked;
    if (includeOff && !confirm('Lấy cả NV đã nghỉ sẽ kéo ~170.000 dòng — chậm hơn nhiều và cache nặng hơn.\n\nTiếp tục?')) return;
    const btn = $('orgSyncBtn'), msg = $('orgSyncMsg');
    busy(btn, true);
    msg.hidden = false;
    msg.textContent = '⏳ Đã gửi yêu cầu, đang kéo dữ liệu...';
    try {
      await api('/api/org/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeOff }) });
      startPolling();
    } catch (err) { msg.textContent = '❌ ' + err.message; busy(btn, false); }
  });

  /* ---------- Cây tổ chức ---------- */
  async function loadTree() {
    const box = $('orgTree');
    try {
      const { tree } = await api('/api/org/tree');
      if (!tree.length) { box.innerHTML = 'Chưa có dữ liệu — bấm <b>Đồng bộ ngay</b>.'; return; }
      box.innerHTML = tree.map((n) => renderNode(n, 0)).join('');
    } catch (err) { box.textContent = 'Lỗi tải cây: ' + err.message; }
  }

  // Cấp 0-1 mở sẵn, sâu hơn thì gấp lại cho đỡ rối.
  function renderNode(n, depth) {
    const kids = n.children || [];
    const label = `<span class="org-name">${esc(n.name)}</span><span class="org-count">${n.count.toLocaleString('vi-VN')}</span>`;
    if (!kids.length) return `<div class="org-leaf" style="--d:${depth}">${label}</div>`;
    return `<details class="org-branch" style="--d:${depth}"${depth < 1 ? ' open' : ''}>`
      + `<summary>${label}</summary>${kids.map((k) => renderNode(k, depth + 1)).join('')}</details>`;
  }

  $('orgTreeExpand').addEventListener('click', () => document.querySelectorAll('#orgTree details').forEach((d) => { d.open = true; }));
  $('orgTreeCollapse').addEventListener('click', () => document.querySelectorAll('#orgTree details').forEach((d) => { d.open = false; }));

  /* ---------- Bộ lọc ---------- */
  const FILTERS = { division: 'orgFilterDivision', department: 'orgFilterDepartment', section: 'orgFilterSection', team: 'orgFilterTeam' };

  async function loadFacets() {
    try {
      const f = await api('/api/org/facets');
      const fill = (id, list) => {
        const sel = $(id);
        const keep = sel.value;
        sel.innerHTML = '<option value="">Tất cả</option>'
          + list.map((o) => `<option value="${esc(o.name)}">${esc(o.name)} (${o.count})</option>`).join('');
        sel.value = keep; // giữ lựa chọn cũ khi nạp lại sau đồng bộ
      };
      fill('orgFilterDivision', f.divisions);
      fill('orgFilterDepartment', f.departments);
      fill('orgFilterSection', f.sections);
      fill('orgFilterTeam', f.teams);
    } catch { /* chưa có cache thì thôi */ }
  }

  function currentQuery() {
    const p = new URLSearchParams();
    const q = $('orgSearch').value.trim();
    if (q) p.set('q', q);
    for (const [key, id] of Object.entries(FILTERS)) {
      const v = $(id).value;
      if (v) p.set(key, v);
    }
    return p;
  }

  /* ---------- Bảng ---------- */
  async function loadList() {
    const body = $('orgBody');
    const p = currentQuery();
    p.set('page', state.page);
    p.set('pageSize', state.pageSize);
    try {
      const r = await api('/api/org?' + p.toString());
      if (r.empty) {
        body.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:1.5rem;color:var(--clr-text-muted)">Chưa có dữ liệu — bấm <b>Đồng bộ ngay</b> ở trên.</td></tr>';
        $('orgCount').textContent = '';
        $('orgPageInfo').textContent = '';
        return;
      }
      state.total = r.total; state.pages = r.pages; state.page = r.page;
      const start = (r.page - 1) * r.pageSize;
      body.innerHTML = r.items.length
        ? r.items.map((e, i) => `<tr>
            <td>${start + i + 1}</td>
            <td><b>${esc(e.employee_name)}</b></td>
            <td>${esc(e.employee_id)}</td>
            <td>${esc(e.jobtitle_name_vn || e.jobtitle_name || '—')}</td>
            <td>${whCell(e)}</td>
            <td>${esc(e.team_name || '—')}</td>
            <td>${esc(e.section_name || '—')}</td>
            <td>${esc(e.department_name || '—')}</td>
            <td>${esc(e.division_name || '—')}</td>
            <td>${esc(e.start_working_date || '—')}</td>
            <td><span class="table-status ${e.status === '1' ? 'active' : 'inactive'}">${esc(e.status_text)}</span></td>
          </tr>`).join('')
        : '<tr><td colspan="11" style="text-align:center;padding:1.5rem;color:var(--clr-text-muted)">Không có ai khớp bộ lọc.</td></tr>';
      $('orgCount').textContent = `${r.total.toLocaleString('vi-VN')} người`;
      $('orgPageInfo').textContent = `Trang ${r.page}/${r.pages}`;
      $('orgPrev').disabled = r.page <= 1;
      $('orgNext').disabled = r.page >= r.pages;
    } catch (err) {
      body.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:1.5rem">Lỗi: ${esc(err.message)}</td></tr>`;
    }
  }

  // Gõ tới đâu lọc tới đó, nhưng đợi 250ms cho hết nhịp gõ rồi mới gọi server.
  let typing = null;
  $('orgSearch').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.page = 1; loadList(); }, 250);
  });
  for (const id of Object.values(FILTERS)) {
    $(id).addEventListener('change', () => { state.page = 1; loadList(); });
  }
  $('orgPageSize').addEventListener('change', () => { state.pageSize = Number($('orgPageSize').value); state.page = 1; loadList(); });
  $('orgPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
  $('orgNext').addEventListener('click', () => { if (state.page < state.pages) { state.page++; loadList(); } });
  $('orgClearFilters').addEventListener('click', () => {
    $('orgSearch').value = '';
    for (const id of Object.values(FILTERS)) $(id).value = '';
    state.page = 1;
    loadList();
  });

  /* ================================================================
     SUB-TAB 2 — NV mới mỗi ngày
     ================================================================ */
  const daily = { items: [], date: null, polling: null };

  async function loadDaily() {
    try {
      const [st, sch] = await Promise.all([api('/api/newhires/status'), api('/api/schedule')]);
      $('dailyEnabled').checked = !!sch.newHiresEnabled;
      $('dailyTime').value = sch.newHiresTime || '08:00';

      const sel = $('dailyDate');
      const keep = sel.value;
      sel.innerHTML = st.dates.length
        ? st.dates.map((d) => `<option value="${d}">${d}</option>`).join('')
        : '<option value="">(chưa chạy lần nào)</option>';
      if (keep && st.dates.includes(keep)) sel.value = keep;

      renderDailyStatus(st);
      if (st.run.running) startDailyPoll();
      await loadDailyRun(sel.value);
    } catch (err) { $('dailyStatus').innerHTML = pill('Lỗi tải: ' + esc(err.message)); }
  }

  function renderDailyStatus(st) {
    const r = st.run || {};
    const pills = [];
    if (!st.configured) {
      $('dailyStatus').innerHTML = pill('⚠️ Chưa cấu hình <b>DATA_API_TOKEN</b> trên máy chủ');
      $('dailyRunBtn').disabled = true;
      return;
    }
    pills.push(pill(`🗓️ Đã lưu <b>${st.dates.length}</b> ngày chạy <small>(giữ ${st.retainDays} ngày gần nhất)</small>`));
    if (r.running) pills.push(pill(`⏳ Đang chạy — <b>${(r.count || 0).toLocaleString('vi-VN')}</b> dòng`));
    else if (r.error) pills.push(pill(`❌ Lỗi: <b>${esc(r.error)}</b>`));
    else if (r.finishedAt) pills.push(pill(`✅ Lượt gần nhất: <b>${(r.count || 0).toLocaleString('vi-VN')}</b> NV mới`));
    if (r.dirCount) pills.push(pill(`🏢 Danh bạ làm mới: <b>${r.dirCount.toLocaleString('vi-VN')}</b> NV`));
    if (r.merged) {
      pills.push(pill(`📥 Vào roster: <b>+${r.merged.added}</b> mới, vá <b>${r.merged.updated}</b> · roster <b>${(r.merged.total || 0).toLocaleString('vi-VN')}</b> NV`));
    }
    if (r.quotaRemaining != null) pills.push(pill(`🎟️ Quota còn <b>${r.quotaRemaining}</b> lượt hôm nay`));
    $('dailyStatus').innerHTML = pills.join('');
    $('dailyRunBtn').disabled = !!r.running;
  }

  function startDailyPoll() {
    if (daily.polling) return;
    daily.polling = setInterval(async () => {
      try {
        const st = await api('/api/newhires/status');
        renderDailyStatus(st);
        if (!st.run.running) {
          clearInterval(daily.polling); daily.polling = null;
          busy($('dailyRunBtn'), false);
          $('dailyMsg').textContent = st.run.error ? '❌ ' + st.run.error : `✅ Xong — ${st.run.count} nhân viên mới.`;
          await loadDaily();
        }
      } catch { /* mạng chớp, lần sau thử lại */ }
    }, 2000);
  }

  async function loadDailyRun(date) {
    const body = $('dailyBody');
    try {
      const r = await api('/api/newhires' + (date ? '?date=' + encodeURIComponent(date) : ''));
      daily.items = r.items || [];
      daily.date = r.date || null;

      // Dropdown "vào ngày" + "bưu cục" dựng từ chính dữ liệu đang có
      const days = [...new Set(daily.items.map((x) => x.start_date))].sort().reverse();
      $('dailyFilterDay').innerHTML = '<option value="">Cả hai</option>'
        + days.map((d) => `<option value="${d}">${d} (${daily.items.filter((x) => x.start_date === d).length})</option>`).join('');
      // Dropdown kho: sắp theo TÊN cho dễ tìm, kho chưa có tên dồn xuống cuối
      const whs = [...new Set(daily.items.map((x) => x.warehouse_id).filter((v) => v != null))]
        .map((id) => ({ id, name: (daily.items.find((x) => x.warehouse_id === id) || {}).warehouse_name || '' }))
        .sort((a, b) => (a.name && b.name ? a.name.localeCompare(b.name, 'vi') : b.name.length - a.name.length || a.id - b.id));
      $('dailyFilterWh').innerHTML = '<option value="">Tất cả</option>'
        + whs.map((w) => {
          const n = daily.items.filter((x) => x.warehouse_id === w.id).length;
          return `<option value="${w.id}">${esc(w.name || w.id)} (${n})</option>`;
        }).join('');

      renderDaily();
    } catch (err) {
      body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1.5rem">Lỗi: ${esc(err.message)}</td></tr>`;
    }
  }

  // Bỏ dấu để gõ "nguyen" ra "Nguyễn" — giống bên danh bạ (server làm, đây làm phía client).
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

  // Ô "Bưu cục / Kho": có tên thì hiện tên (kèm mã mờ bên dưới), chưa có tên thì hiện mã.
  // Danh mục kho đang dán tay và mới phủ ~20% NV — phải nhìn ra được cái nào chưa tra được.
  const whCell = (x) => {
    if (x.warehouse_id == null) return '—';
    return x.warehouse_name
      ? `${esc(x.warehouse_name)}<br><small style="color:var(--clr-text-muted)">${esc(x.warehouse_id)}</small>`
      : `<span style="color:var(--clr-text-muted)">${esc(x.warehouse_id)}</span>`;
  };

  function renderDaily() {
    const q = fold($('dailySearch').value.trim());
    const day = $('dailyFilterDay').value;
    const wh = $('dailyFilterWh').value;
    const rows = daily.items.filter((x) => {
      if (day && x.start_date !== day) return false;
      if (wh && String(x.warehouse_id) !== wh) return false;
      if (q && !fold(`${x.employee_name} ${x.employee_id}`).includes(q)) return false;
      return true;
    });

    $('dailyBody').innerHTML = rows.length
      ? rows.map((x, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(x.employee_id)}</td>
          <td><b>${esc(x.employee_name)}</b></td>
          <td>${esc(x.jobtitle_name_vn || '—')}</td>
          <td>${esc(x.department_name || '—')}</td>
          <td>${esc(x.section_name || '—')}</td>
          <td>${whCell(x)}</td>
          <td>${esc(x.start_date || '—')}</td>
        </tr>`).join('')
      : `<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--clr-text-muted)">${daily.items.length ? 'Không có ai khớp bộ lọc.' : 'Chưa có dữ liệu — bấm <b>Chạy ngay</b>.'}</td></tr>`;
    $('dailyCount').textContent = `${rows.length.toLocaleString('vi-VN')} người`;
  }

  $('dailySearch').addEventListener('input', renderDaily);
  $('dailyFilterDay').addEventListener('change', renderDaily);
  $('dailyFilterWh').addEventListener('change', renderDaily);
  $('dailyClearFilters').addEventListener('click', () => {
    $('dailySearch').value = ''; $('dailyFilterDay').value = ''; $('dailyFilterWh').value = '';
    renderDaily();
  });
  $('dailyDate').addEventListener('change', () => loadDailyRun($('dailyDate').value));

  $('dailySaveBtn').addEventListener('click', async () => {
    const msg = $('dailyMsg');
    try {
      // Chỉ gửi 2 trường của mình — /api/schedule merge, không đụng lịch crawl bên tab Bộ dữ liệu.
      const r = await api('/api/schedule', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newHiresEnabled: $('dailyEnabled').checked, newHiresTime: $('dailyTime').value }),
      });
      const s = r.schedule;
      msg.textContent = `✓ Đã lưu — tự lấy NV mới ${s.newHiresEnabled ? s.newHiresTime + ' hằng ngày' : 'tắt'}.`;
    } catch (err) { msg.textContent = '✗ ' + err.message; }
  });

  $('dailyRunBtn').addEventListener('click', async () => {
    const btn = $('dailyRunBtn'), msg = $('dailyMsg');
    busy(btn, true);
    msg.textContent = '⏳ Đang hỏi Data API...';
    try {
      await api('/api/newhires/run', { method: 'POST' });
      startDailyPoll();
    } catch (err) { msg.textContent = '❌ ' + err.message; busy(btn, false); }
  });

  $('dailyExportBtn').addEventListener('click', () => {
    const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['Employee ID', 'Họ tên', 'Chức danh', 'Department', 'Section', 'Team', 'Tên kho / bưu cục', 'Mã kho', 'Unit ID', 'Ngày vào'];
    const cols = ['employee_id', 'employee_name', 'jobtitle_name_vn', 'department_name', 'section_name', 'team_name', 'warehouse_name', 'warehouse_id', 'unit_id', 'start_date'];
    const csv = [head.map(cell).join(','), ...daily.items.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `nv-moi-${daily.date || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------- Xuất CSV ---------- */
  // Lấy TOÀN BỘ kết quả đang lọc (không chỉ trang đang xem) rồi tải về.
  $('orgExportBtn').addEventListener('click', async () => {
    const btn = $('orgExportBtn');
    busy(btn, true);
    try {
      const p = currentQuery();
      p.set('page', 1);
      p.set('pageSize', 500);
      const first = await api('/api/org?' + p.toString());
      const items = first.items || [];
      for (let page = 2; page <= (first.pages || 1); page++) {
        p.set('page', page);
        const r = await api('/api/org?' + p.toString());
        items.push(...(r.items || []));
      }
      const cols = ['employee_id', 'employee_name', 'jobtitle_name_vn', 'warehouse_name', 'warehouse_id', 'team_name', 'section_name', 'department_name', 'division_name', 'start_working_date', 'status_text'];
      const head = ['Employee ID', 'Họ tên', 'Chức danh', 'Tên kho / bưu cục', 'Mã kho', 'Nhóm', 'Bộ phận', 'Phòng', 'Khối', 'Ngày vào', 'Trạng thái'];
      // Bọc nháy kép hết cho an toàn (tên có dấu phẩy), nháy trong ô thì nhân đôi.
      const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const csv = [head.map(cell).join(','), ...items.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
      // BOM để Excel nhận UTF-8, không thì tên tiếng Việt ra ký tự lạ.
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `danh-ba-to-chuc-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { alert('Lỗi xuất CSV: ' + err.message); }
    busy(btn, false);
  });
})();
