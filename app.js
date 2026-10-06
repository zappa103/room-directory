/* Campus Room Directory — front end
   Talks to the Google Apps Script web app (see apps-script/Code.gs).
   With no API_URL in config.js it runs in demo mode on demo-data.js. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const DEMO = !CFG.API_URL;
  const EDIT_ROLES = ['Technician', 'Admin'];
  const STALE = CFG.STALE_YEARS || 8;
  const ROOM_FIELDS_EDIT = [
    ['Room details', [['Building', 'locked'], ['Room', 'locked'], ['Building Number', 'locked'], ['Room Type', 'text'], ['Reservations', 'text'], ['Zone', 'text'],
      ['Seating Capacity', 'text'], ['Square Footage', 'text'], ['Seating Configuration', 'text'], ['Floor Type', 'text'],
      ['PC Port', 'text'], ['AV Port', 'text'], ['Notes', 'area']]],
    ['Status', [['CTL Supported', ['Yes', 'No']], ['Record Type', ['CTL Supported', 'CTL Updated', 'Contact Info Only']],
      ['Equipment Info As Of', 'text'], ['Latest Update', 'text'], ['Planned Update Year', 'text'], ['Funding Status', ['Funding Requested', 'Funding Approved']], ['Funding Source', ['STF', 'Client Funded']], ['Photos URL', 'text', 'Photos link (view only, public)'], ['Photos Upload URL', 'text', 'Photos link (can edit, for adding photos)'], ['GVE Room ID', 'text']]],
  ];
  const CONTACTS = [
    ['AV Support', 'AV Support Contact', 'AV Support Email', 'AV Support Phone'],
    ['Computer Support', 'Computer Support Contact', 'Computer Support Email', 'Computer Support Phone'],
    ['Department Contact', 'Department Contact', 'Department Contact Email', 'Department Contact Phone'],
  ];
  const CATEGORY_ORDER = ['Instructor Computer', 'Cabinet', 'Projector', 'Wall Display', 'Touchpanel', 'Controller', 'Switcher',
    'Lavalier Mic', 'Handheld Mic', 'Mic Receiver', 'Document Camera', 'Blu-ray / DVD Player', 'Amplifier', 'Speaker',
    'Power Conditioner', 'HDMI Extender', 'Video Conferencing'];

  const S = { zones: [], user: null, role: null, token: null, rooms: [], equipment: [], catalog: [], users: null,
    page: 'rooms', q: '', building: '', ctlOnly: false, limit: 120, open: null, tab: null,
    catOpen: new Set(), catEditing: null, catAdding: null, addingRoom: false };

  // ------------------------------------------------------------------ utils
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const has = v => v !== undefined && v !== null && String(v).trim() !== '';
  const canEdit = () => EDIT_ROLES.includes(S.role);
  const isContactOnly = r => r['Record Type'] === 'Contact Info Only';
  const isCTL = r => String(r['CTL Supported']).toLowerCase() === 'yes' || r['Record Type'] === 'CTL Supported';
  const roomName = r => `${r.Building} ${r.Room}`;
  const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  const catRank = c => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  function asOfYear(v) { const m = /^(\d{4})/.exec(String(v || '')); return m ? +m[1] : null; }
  function isStale(r) {
    if (!has(r['Equipment Info As Of'])) return false;
    const s = String(r['Equipment Info As Of']);
    const d = /^\d{4}$/.test(s) ? new Date(+s, 11, 31) : new Date(s);
    if (isNaN(d)) return false;
    const cut = new Date(); cut.setFullYear(cut.getFullYear() - STALE);
    return d < cut;
  }
  // A room with a planned update this year or later (funding requested/approved) is pending, not overdue.
  function plannedYear(r) { const y = asOfYear(r['Planned Update Year']); return y && y >= new Date().getFullYear() ? y : null; }
  function plannedText(r) {
    const y = plannedYear(r); if (!y) return '';
    const bits = [r['Funding Source'], has(r['Funding Status']) ? String(r['Funding Status']).toLowerCase() : ''].filter(has);
    return `Update planned for ${y}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`;
  }
  function toast(msg, err) {
    const root = $('#toast-root');
    root.innerHTML = `<div class="toast ${err ? 'err' : ''}" role="status">${esc(msg)}</div>`;
    clearTimeout(toast.t); toast.t = setTimeout(() => { root.innerHTML = ''; }, err ? 6000 : 2600);
  }
  const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';

  // ------------------------------------------------------------------ API
  async function api(action, payload) {
    if (DEMO) return DemoAPI.call(action, payload || {}, S.role);
    if (action === 'public') {
      const res = await fetch(CFG.API_URL + '?action=public');
      return res.json();
    }
    const res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, idToken: S.token }, payload || {})) });
    const data = await res.json();
    if (!data.ok && data.error === 'not_authorized') { signOut(true); throw new Error(data.message || 'Not authorized'); }
    if (!data.ok) throw new Error(data.message || data.error || 'Something went wrong');
    return data;
  }

  // ------------------------------------------------------------------ auth
  function tokenExp(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch (e) { return 0; } }
  function initGoogle() {
    if (DEMO || !CFG.GOOGLE_CLIENT_ID) return;
    if (!window.google || !google.accounts) { setTimeout(initGoogle, 200); return; }
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: r => onCredential(r.credential), auto_select: true });
    renderAccount();
  }
  async function onCredential(token) {
    S.token = token;
    try { sessionStorage.setItem('idToken', token); } catch (e) {}
    await loadSession();
  }
  async function loadSession() {
    try {
      const d = await api('session');
      S.user = d.user; S.role = d.user.role; S.rooms = d.rooms; S.equipment = d.equipment || []; S.catalog = d.catalog || []; S.zones = d.zones || [];
      toast(`Signed in as ${S.user.name} (${S.role})`);
    } catch (e) { toast(e.message, true); }
    renderAll();
  }
  function signOut(silent) {
    S.user = null; S.role = null; S.token = null; S.equipment = []; S.catalog = []; S.users = null; S.page = 'rooms';
    try { sessionStorage.removeItem('idToken'); } catch (e) {}
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    if (!silent) loadPublic();
  }
  async function loadPublic() {
    try { const d = await api('public'); S.rooms = d.rooms || []; }
    catch (e) { $('#main').innerHTML = `<div class="empty">Could not load rooms. ${esc(e.message)}</div>`; return; }
    renderAll();
  }

  // ------------------------------------------------------------------ header
  function renderAccount() {
    const el = $('#account');
    if (S.user) {
      el.innerHTML = `<span class="user-chip">${esc(S.user.name)} <span class="role-pill">${esc(S.role)}</span></span>
        ${DEMO ? '' : '<button class="link-btn" id="signout">Sign out</button>'}`;
      if (!DEMO) $('#signout').onclick = () => { signOut(); toast('Signed out'); };
    } else if (DEMO) {
      el.innerHTML = '';
    } else {
      el.innerHTML = '<div id="gsi-btn"></div>';
      if (window.google && google.accounts) google.accounts.id.renderButton($('#gsi-btn'), { theme: 'outline', size: 'medium', text: 'signin' });
    }
    const tabs = $('#page-tabs');
    const pages = [['rooms', 'Rooms']];
    if (canEdit()) pages.push(['catalog', 'Equipment Catalog'], ['reports', 'Reports'], ['zones', 'Zones']);
    if (S.role === 'Admin') pages.push(['users', 'Users']);
    tabs.hidden = pages.length < 2;
    tabs.innerHTML = pages.map(([k, l]) => `<button class="page-tab ${S.page === k ? 'active' : ''}" data-page="${k}">${l}</button>`).join('');
    $$('.page-tab', tabs).forEach(b => b.onclick = () => { S.page = b.dataset.page; renderAll(); });
  }
  function renderDemoBar() {
    const bar = $('#demo-bar');
    if (!DEMO) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<strong>Demo mode</strong><span>Sample data only. Nothing is saved. View as</span>
      <select id="demo-role" aria-label="View as role">${['Public', 'Student', 'Technician', 'Admin'].map(r =>
        `<option ${((S.role || 'Public') === r) ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
    $('#demo-role').onchange = async e => {
      const r = e.target.value;
      if (r === 'Public') { S.user = null; S.role = null; S.page = 'rooms'; await loadPublic(); }
      else { S.role = r; S.user = { name: 'Demo ' + r, email: 'demo@example.com', role: r }; if (!canEdit() && S.page !== 'rooms') S.page = 'rooms'; await loadSession(); }
    };
  }
  function renderAll() {
    $('#site-title').textContent = CFG.SITE_TITLE || 'Campus Room Directory';
    $('#site-sub').textContent = CFG.SITE_SUBTITLE || '';
    document.title = CFG.SITE_TITLE || 'Campus Room Directory';
    renderAccount(); renderDemoBar();
    if (S.page === 'catalog' && canEdit()) renderCatalog();
    else if (S.page === 'reports' && canEdit()) renderReports();
    else if (S.page === 'zones' && canEdit()) renderZones();
    else if (S.page === 'users' && S.role === 'Admin') renderUsers();
    else { S.page = 'rooms'; renderRooms(); }
    if (S.open) renderPanel();
  }

  // ------------------------------------------------------------------ rooms page
  function filteredRooms() {
    const q = S.q.trim().toLowerCase();
    const eqByRoom = canEdit() ? equipIndex() : {};
    return S.rooms.filter(r => {
      if (S.building && r.Building !== S.building) return false;
      if (S.ctlOnly && !isCTL(r)) return false;
      if (!q) return true;
      const hay = [r.Building, r.Room, r['Room Type'], r.Department, r.College, r.Zone,
        r['AV Support Contact'], r['Computer Support Contact'], r['CTL Tech'],
        (eqByRoom[r.RoomID] || []).map(e => e.Model).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    }).sort((a, b) => cmp(a.Building, b.Building) || cmp(a.Room, b.Room));
  }
  function equipIndex() { const m = {}; S.equipment.forEach(e => { (m[e.RoomID] = m[e.RoomID] || []).push(e); }); return m; }

  function renderRooms() {
    const buildings = Array.from(new Set(S.rooms.map(r => r.Building))).sort(cmp);
    const main = $('#main');
    main.innerHTML = `
      <div class="controls">
        <input class="search" id="q" type="search" placeholder="Search building, room${canEdit() ? ', equipment' : ''}${S.role ? ', contact' : ''}…" value="${esc(S.q)}" aria-label="Search">
        <select class="dd" id="dd-building" aria-label="Building"><option value="">All buildings</option>${buildings.map(b => `<option ${b === S.building ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        <select class="dd" id="dd-room" aria-label="Room"><option value="">Jump to room…</option></select>
        <button class="chip ${S.ctlOnly ? 'active' : ''}" id="ctl-only">CTL-supported only</button>
        ${S.role === 'Admin' ? '<button class="btn" id="add-room">+ Add room</button>' : ''}
        <span class="count" id="count"></span>
      </div>
      <div id="add-room-form"></div>
      <div class="grid" id="grid"></div>
      <div class="more" id="more"></div>`;
    $('#q').oninput = e => { S.q = e.target.value; S.limit = 120; drawGrid(); };
    $('#dd-building').onchange = e => { S.building = e.target.value; S.limit = 120; fillRoomDD(); drawGrid(); };
    $('#dd-room').onchange = e => { const r = S.rooms.find(x => x.RoomID === e.target.value); if (r) openRoom(r); e.target.value = ''; };
    $('#ctl-only').onclick = () => { S.ctlOnly = !S.ctlOnly; renderRooms(); };
    if ($('#add-room')) $('#add-room').onclick = () => { S.addingRoom = !S.addingRoom; drawAddRoom(); };
    fillRoomDD(); drawAddRoom(); drawGrid();
  }
  function fillRoomDD() {
    const dd = $('#dd-room'); if (!dd) return;
    const list = S.rooms.filter(r => !S.building || r.Building === S.building).sort((a, b) => cmp(a.Building, b.Building) || cmp(a.Room, b.Room));
    dd.innerHTML = '<option value="">Jump to room…</option>' + list.map(r => `<option value="${esc(r.RoomID)}">${esc(S.building ? r.Room : roomName(r))}</option>`).join('');
  }
  function drawGrid() {
    const list = filteredRooms();
    $('#count').textContent = `${list.length} room${list.length === 1 ? '' : 's'}`;
    const grid = $('#grid');
    if (!list.length) { grid.innerHTML = ''; $('#more').innerHTML = '<div class="empty">No rooms match your search.</div>'; return; }
    grid.innerHTML = list.slice(0, S.limit).map(r => {
      const lines = [];
      if (has(r.Zone)) lines.push(`<div><b>Zone:</b> ${esc(r.Zone)}</div>`);
      if (S.role) {
        if (has(r['AV Support Contact'])) lines.push(`<div><b>AV:</b> ${esc(r['AV Support Contact'])}</div>`);
        if (has(r['Computer Support Contact'])) lines.push(`<div><b>Computer:</b> ${esc(r['Computer Support Contact'])}</div>`);
      } else if (has(r.Department)) lines.push(`<div><b>Department:</b> ${esc(r.Department)}</div>`);
      return `<button class="plaque ${isContactOnly(r) ? 'contact-only' : ''}" data-id="${esc(r.RoomID)}">
        <div class="idline">${esc(r.Building)}<br>${esc(r.Room)}</div>
        <div class="tags">${isCTL(r) ? `<span class="tag ctl">${CHECK}CTL</span>` : '<span class="tag nonctl">Non-CTL</span>'}</div>
        <div class="lines">${lines.join('')}</div></button>`;
    }).join('');
    $$('.plaque', grid).forEach(b => b.onclick = () => openRoom(S.rooms.find(r => r.RoomID === b.dataset.id)));
    $('#more').innerHTML = list.length > S.limit ? `<button class="btn" id="show-more">Show ${Math.min(120, list.length - S.limit)} more of ${list.length - S.limit}</button>` : '';
    if ($('#show-more')) $('#show-more').onclick = () => { S.limit += 120; drawGrid(); };
  }
  function drawAddRoom() {
    const wrap = $('#add-room-form'); if (!wrap) return;
    if (!S.addingRoom) { wrap.innerHTML = ''; return; }
    const buildings = Array.from(new Set(S.rooms.map(r => r.Building))).sort(cmp);
    wrap.innerHTML = `<form class="inline-form" id="new-room">
      <label>Building (pick one or type a new name)<input list="bl" id="nr-b" required><datalist id="bl">${buildings.map(b => `<option value="${esc(b)}">`).join('')}</datalist></label>
      <label>Room number<input id="nr-r" required></label>
      <label>Room type<input id="nr-t" placeholder="Classroom"></label>
      <label>Zone<input id="nr-z"></label>
      <label>Record type<select id="nr-rt"><option>Contact Info Only</option><option>CTL Updated</option><option>CTL Supported</option></select></label>
      <button class="btn primary small" type="submit">Create room</button>
      <button class="btn small" type="button" id="nr-cancel">Cancel</button></form>`;
    $('#nr-cancel').onclick = () => { S.addingRoom = false; drawAddRoom(); };
    $('#new-room').onsubmit = async e => {
      e.preventDefault();
      const rt = $('#nr-rt').value;
      const room = { Building: $('#nr-b').value.trim(), Room: $('#nr-r').value.trim(), 'Room Type': $('#nr-t').value.trim(), Zone: $('#nr-z').value.trim(),
        'Record Type': rt, 'CTL Supported': rt === 'CTL Supported' ? 'Yes' : 'No' };
      try { const d = await api('addRoom', { room }); S.rooms.push(d.room); S.addingRoom = false; toast('Room added'); renderRooms(); openRoom(d.room); }
      catch (err) { toast(err.message, true); }
    };
  }

  // ------------------------------------------------------------------ room panel
  function openRoom(r) {
    if (!r) return;
    S.open = r.RoomID;
    S.tab = canEdit() ? 'main' : (S.role ? 'contacts' : 'info');
    S.confirmRemove = false; S.editField = null; S.eqEdit = null; S.eqAdding = false; S.history = null;
    renderPanel();
  }
  function closePanel() { S.open = null; $('#overlay-root').innerHTML = ''; document.body.style.overflow = ''; }
  function currentRoom() { return S.rooms.find(r => r.RoomID === S.open); }

  function renderPanel() {
    const r = currentRoom(); if (!r) { closePanel(); return; }
    const old = $('.panel'); const keep = old && S.lastPanel === S.open + '|' + S.tab ? old.scrollTop : 0;
    S.lastPanel = S.open + '|' + S.tab;
    const restore = () => { const p = $('.panel'); if (p) p.scrollTop = keep; };
    const tabs = canEdit() ? [['main', 'Room & support contacts'], ['equipment', 'Equipment'], ['history', 'History']]
      : S.role ? [['contacts', 'Support contacts'], ['info', 'Room']] : [];
    const photo = (has(r['Photos URL']) ? `<a class="photo-btn" href="${esc(r['Photos URL'])}" target="_blank" rel="noopener">View photos ↗</a>` : '') +
      (canEdit() && has(r['Photos Upload URL']) ? `<a class="photo-btn add" href="${esc(r['Photos Upload URL'])}" target="_blank" rel="noopener" title="Opens the room's OneDrive folder. Use Upload there to take or add photos.">Add photos ↗</a>` : '');
    $('#overlay-root').innerHTML = `<div class="overlay" id="overlay"><aside class="panel" role="dialog" aria-modal="true" aria-label="${esc(roomName(r))}">
      <div class="panel-head">
        <button class="panel-close" id="close" aria-label="Close">×</button>
        <div class="panel-title">${esc(r.Building)}<br>${esc(r.Room)}</div>
        <div class="panel-sub">${has(r.Department) ? esc(r.Department) + ' · ' : ''}${has(r.Zone) ? 'Zone: ' + esc(r.Zone) + ' · ' : ''}${isCTL(r) ? 'CTL' : 'Non-CTL'}</div>
        ${photo}
      </div>
      ${tabs.length ? `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'active' : ''}" data-tab="${k}" role="tab">${l}</button>`).join('')}</div>` : ''}
      <div class="panel-body" id="pbody"></div>
      <div id="pfoot"></div>
    </aside></div>`;
    document.body.style.overflow = 'hidden';
    $('#close').onclick = closePanel;
    $('#overlay').onclick = e => { if (e.target.id === 'overlay') closePanel(); };
    $$('.tab').forEach(t => t.onclick = () => { S.tab = t.dataset.tab; S.editField = null; S.eqEdit = null; S.eqAdding = false; renderPanel(); });
    const body = $('#pbody'), foot = $('#pfoot');
    if (S.tab === 'info' || !S.role) { body.innerHTML = infoHtml(r) + (has(r['Photos URL']) ? '' : '<div class="note">No photos linked for this room yet.</div>'); return; }
    if (S.tab === 'contacts') { body.innerHTML = contactsHtml(r); return; }
    if (S.tab === 'main') { body.innerHTML = contactsEditHtml(r) + roomEditHtml(r); foot.innerHTML = roomFoot(); wireFieldEdits(r); wireRoomFoot(r); restore(); return; }
    if (S.tab === 'equipment') { renderEquipmentTab(r); restore(); return; }
    if (S.tab === 'equipment') { renderEquipmentTab(r); return; }
    if (S.tab === 'history') { renderHistory(r); return; }
  }
  function infoHtml(r) {
    const rows = [['Building', r.Building], ['Room', r.Room], ['Room type', r['Room Type']], ['Department', r.Department], ['College', r.College], ['Zone', r.Zone]];
    return '<div class="section-title">Room</div>' + rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v ${has(v) ? '' : 'none'}">${has(v) ? esc(v) : 'Not recorded'}</span></div>`).join('');
  }
  function contactLine(v, kind) {
    if (!has(v)) return '';
    if (kind === 'email') return `<div class="line"><a href="mailto:${esc(v)}">${esc(v)}</a></div>`;
    return `<div class="line">${esc(v)}</div>`;
  }
  // CTL contact for a room comes from its zone (Zones tab), plus that zone's backup.
  function zoneInfo(r) {
    const key = String(r.Zone || '').trim().toLowerCase();
    const z = S.zones.find(x => String(x.Zone).trim().toLowerCase() === key);
    if (!z) return { name: r['CTL Tech'], email: r['CTL Tech Email'], phone: r['CTL Tech Phone'],
      bZone: r['Backup Zone'], bName: r['Backup Tech'], bEmail: r['Backup Tech Email'], bPhone: r['Backup Tech Phone'] };
    const b = has(z['Backup Zone']) ? S.zones.find(x => String(x.Zone).trim().toLowerCase() === String(z['Backup Zone']).trim().toLowerCase()) : null;
    return { name: z['CTL Technician'], email: z.Email, phone: z.Phone, bZone: b ? b.Zone : '', bName: b ? b['CTL Technician'] : '', bEmail: b ? b.Email : '', bPhone: b ? b.Phone : '' };
  }
  function ctlCard(r, editing) {
    const z = zoneInfo(r);
    const label = isCTL(r) ? 'CTL Support' : 'CTL Support (second tier)';
    if (!has(z.name)) return editing ? `<div class="contact"><div class="role">${label}</div><div class="line">No CTL technician for this room's zone${has(r.Zone) ? ' (' + esc(r.Zone) + ')' : ''}. Set the zone below, or add the zone on the Zones page.</div></div>` : '';
    const backup = has(z.bName) ? `<div class="backup">If ${esc(String(z.name).split(' ')[0])} is unavailable, call ${esc(z.bName)} (${esc(z.bZone)} zone)${has(z.bPhone) ? ' · ' + esc(z.bPhone) : ''}</div>` : '';
    return `<div class="contact ctl-contact"><div class="role">${label}${has(r.Zone) ? ' · ' + esc(r.Zone) + ' zone' : ''}</div><div class="name">${esc(z.name)}</div>${contactLine(z.email, 'email')}${contactLine(z.phone)}${backup}
      ${editing ? '<div class="line" style="opacity:.6;font-size:11.5px;margin-top:6px">Comes from the room\'s zone. Change technicians on the Zones page.</div>' : ''}</div>`;
  }
  function contactsHtml(r) {
    let html = '<div class="section-title">Support contacts</div>';
    let any = false;
    const ctl = ctlCard(r, false);
    const dept = [['Department', r.Department], ['College', r.College], ['Primary support unit', r['Primary Support Unit']]].filter(x => has(x[1]));
    if (dept.length) html += `<div class="contact"><div class="role">Department</div>${dept.map(([k, v]) => `<div class="line"><span style="opacity:.65">${k}:</span> ${esc(v)}</div>`).join('')}</div>`;
    if (ctl && isCTL(r)) { any = true; html += ctl; }
    CONTACTS.forEach(([label, n, e, p]) => {
      if (!has(r[n]) && !has(r[e]) && !has(r[p])) return;
      any = true;
      html += `<div class="contact"><div class="role">${label}</div><div class="name">${esc(r[n] || '—')}</div>${contactLine(r[e], 'email')}${contactLine(r[p])}</div>`;
    });
    if (ctl && !isCTL(r)) { any = true; html += ctl; }
    if (has(r['Help / Ticket Website'])) { any = true; html += `<div class="contact"><div class="role">Submit a ticket</div><div class="line"><a href="${esc(r['Help / Ticket Website'])}" target="_blank" rel="noopener">${esc(r['Help / Ticket Website'])}</a></div></div>`; }
    if (!any) html += '<div class="note">No support contacts on file for this room.</div>';
    return html;
  }
  function input(field, val, kind) {
    const id = 'f-' + field.replace(/\W+/g, '-');
    if (Array.isArray(kind)) return `<select id="${id}" data-field="${esc(field)}"><option value=""></option>${kind.map(o => `<option ${String(val) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    if (kind === 'area') return `<textarea id="${id}" data-field="${esc(field)}">${esc(val)}</textarea>`;
    return `<input id="${id}" data-field="${esc(field)}" value="${esc(val)}" placeholder="—">`;
  }
  // Read-only rows with an Edit button; only the field being edited becomes an input.
  function fieldRow(r, field, label, kind) {
    const v = r[field];
    if (kind === 'locked') return `<div class="row"><span class="k">${esc(label)}</span><span class="v ${has(v) ? '' : 'none'}">${has(v) ? esc(v) : 'Not recorded'}</span><span class="lock-note" title="To change this, add a new room">Fixed</span></div>`;
    if (S.editField === field) {
      return `<div class="row editing"><span class="k">${esc(label)}</span><span class="edit-wrap">${input(field, v, kind)}
        <button class="btn primary small" data-fsave="${esc(field)}">Save</button><button class="btn small" data-fcancel>Cancel</button></span></div>`;
    }
    const shown = !has(v) ? 'Not recorded' : (field === 'Photos URL' || field === 'Photos Upload URL' || field === 'Help / Ticket Website') ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v);
    return `<div class="row"><span class="k">${esc(label)}</span><span class="v ${has(v) ? '' : 'none'}">${shown}</span>
      <button class="edit-btn" data-fedit="${esc(field)}" aria-label="Edit ${esc(label)}">Edit</button></div>`;
  }
  function contactsEditHtml(r) {
    let html = '<div class="section-title">Support contacts</div>';
    html += `<div class="contact"><div class="role">Department</div>${fieldRow(r, 'Department', 'Department')}${fieldRow(r, 'College', 'College')}${fieldRow(r, 'Primary Support Unit', 'Primary support unit')}</div>`;
    if (isCTL(r)) html += ctlCard(r, true);
    CONTACTS.forEach(([label, n, e, p]) => {
      html += `<div class="contact"><div class="role">${label}</div>${fieldRow(r, n, 'Name')}${fieldRow(r, e, 'Email')}${fieldRow(r, p, 'Phone')}</div>`;
    });
    if (!isCTL(r)) html += ctlCard(r, true);
    html += fieldRow(r, 'Help / Ticket Website', 'Help / ticket website');
    return html;
  }
  function roomEditHtml(r) {
    return ROOM_FIELDS_EDIT.map(([title, fields]) => `<div class="section-title">${title}</div>` +
      fields.map(([f, kind, label]) => fieldRow(r, f, label || f, kind)).join('')).join('');
  }
  function wireFieldEdits(r) {
    $$('#pbody [data-fedit]').forEach(b => b.onclick = () => { S.editField = b.dataset.fedit; renderPanel(); const el = $('#pbody .editing [data-field]'); if (el) { el.focus(); if (el.select) el.select(); } });
    const cancel = () => { S.editField = null; renderPanel(); };
    const save = async () => {
      const el = $('#pbody .editing [data-field]'); if (!el) return;
      const f = el.dataset.field, v = el.value.trim();
      if (String(r[f] == null ? '' : r[f]) === v) { cancel(); return; }
      try {
        const d = await api('saveRoom', { roomId: r.RoomID, changes: { [f]: v } });
        Object.assign(r, d.room); S.editField = null; toast(`${f} saved`); renderAll();
      } catch (e) { toast(e.message, true); }
    };
    $$('#pbody [data-fcancel]').forEach(b => b.onclick = cancel);
    $$('#pbody [data-fsave]').forEach(b => b.onclick = save);
    const el = $('#pbody .editing [data-field]');
    if (el) el.onkeydown = e => { if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
  }
  function roomFoot() {
    if (S.confirmRemove) return `<div class="save-bar"><div class="confirm">Remove this room from the directory? It moves to the Removed Rooms tab.
      <button class="btn danger small" id="rm-yes">Remove room</button><button class="btn small" id="rm-no">Keep it</button></div></div>`;
    return `<div class="save-bar"><button class="btn danger small" id="rm">Remove room</button><span style="font-size:12px;opacity:.65;align-self:center">Click Edit next to a field to change it. Each change saves on its own.</span></div>`;
  }
  function wireRoomFoot(r) {
    if (S.confirmRemove) {
      $('#rm-no').onclick = () => { S.confirmRemove = false; renderPanel(); };
      $('#rm-yes').onclick = async () => {
        try { await api('removeRoom', { roomId: r.RoomID }); S.rooms = S.rooms.filter(x => x.RoomID !== r.RoomID); closePanel(); toast('Room removed'); renderAll(); }
        catch (e) { toast(e.message, true); }
      };
      return;
    }
    $('#rm').onclick = () => { S.confirmRemove = true; renderPanel(); };
  }

  // equipment tab: read-only list, Edit per item, "+ Add equipment" opens a form
  function roomItems(r) { return S.equipment.filter(e => e.RoomID === r.RoomID).map(e => ({ Category: e.Category, Model: e.Model, Qty: e.Qty })); }
  async function saveItems(r, items, msg) {
    const clean = items.filter(i => String(i.Model).trim()).map(i => ({ Category: i.Category, Model: String(i.Model).trim(), Qty: i.Qty === '' || i.Qty == null ? '' : Number(i.Qty) }));
    try {
      const d = await api('saveEquipment', { roomId: r.RoomID, items: clean });
      S.equipment = S.equipment.filter(e => e.RoomID !== r.RoomID).concat(d.equipment);
      if (d.catalog) S.catalog = d.catalog;
      S.eqEdit = null; S.eqAdding = false; toast(msg); renderPanel();
    } catch (e) { toast(e.message, true); }
  }
  function renderEquipmentTab(r) {
    const items = roomItems(r);
    let html = '';
    if (isStale(r)) html += `<div class="note stale"><div><b>Equipment information as of ${esc(r['Equipment Info As Of'])}</b>CTL's last install or update in this room was more than ${STALE} years ago. This list may not match what is in the room now.${plannedYear(r) ? ' ' + esc(plannedText(r)) + '.' : ''}</div></div>`;
    else if (plannedYear(r)) html += `<div class="note"><div><b>${esc(plannedText(r))}</b></div></div>`;
    if (isContactOnly(r)) html += '<div class="note"><div><b>Contact-only room</b>This list is only visible to technicians and admins.</div></div>';
    const cats = Array.from(new Set(items.map(i => i.Category))).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
    if (!items.length) html += '<div class="note">No equipment on file for this room.</div>';
    cats.forEach(cat => {
      const lid = 'dl-' + cat.replace(/\W+/g, '-');
      html += `<div class="eq-group"><div class="eq-cat">${esc(cat)}</div>`;
      items.forEach((it, i) => {
        if (it.Category !== cat) return;
        if (S.eqEdit === i) {
          html += `<datalist id="${lid}">${S.catalog.filter(c => c.Category === cat).map(c => `<option value="${esc(c.Model)}">`).join('')}</datalist>
            <div class="eq-row editing"><input class="model-in" id="ee-model" list="${lid}" value="${esc(it.Model)}" aria-label="Model">
            <input class="qty-in" id="ee-qty" type="number" min="0" value="${esc(it.Qty)}" placeholder="?" aria-label="Quantity">
            <button class="btn primary small" id="ee-save">Save</button><button class="btn small" id="ee-x">Cancel</button>
            <button class="btn danger small" id="ee-del">Remove</button></div>`;
        } else {
          html += `<div class="eq-row"><span class="model">${esc(it.Model)}</span><span class="qty" ${it.Qty === '' || it.Qty == null ? 'title="Quantity not recorded"' : ''}>×${it.Qty === '' || it.Qty == null ? '?' : esc(it.Qty)}</span>
            <button class="edit-btn" data-eedit="${i}" aria-label="Edit ${esc(it.Model)}">Edit</button></div>`;
        }
      });
      html += '</div>';
    });
    const allCats = Array.from(new Set(CATEGORY_ORDER.concat(S.catalog.map(c => c.Category)))).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
    html += S.eqAdding ? `<form class="inline-form" id="add-form" style="margin-top:12px">
        <label>Category<select id="add-cat">${allCats.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label>Model (pick or type a new one)<input id="add-model" list="dl-add" required><datalist id="dl-add"></datalist></label>
        <label>Qty<input id="add-qty" type="number" min="0" value="1" style="min-width:0;width:70px"></label>
        <button class="btn primary small" type="submit">Add</button><button class="btn small" type="button" id="add-x">Cancel</button></form>`
      : '<button class="btn small" id="add-open" style="margin-top:10px">+ Add equipment</button>';
    $('#pbody').innerHTML = html;
    $('#pfoot').innerHTML = '';
    $$('#pbody [data-eedit]').forEach(b => b.onclick = () => { S.eqEdit = +b.dataset.eedit; S.eqAdding = false; renderPanel(); $('#ee-model').focus(); });
    if ($('#ee-save')) {
      const i = S.eqEdit;
      $('#ee-x').onclick = () => { S.eqEdit = null; renderPanel(); };
      $('#ee-save').onclick = () => { if (!$('#ee-model').value.trim()) { toast('Enter a model', true); return; } items[i].Model = $('#ee-model').value.trim(); items[i].Qty = $('#ee-qty').value; saveItems(r, items, 'Equipment saved'); };
      $('#ee-del').onclick = () => { items.splice(i, 1); saveItems(r, items, 'Item removed'); };
      $('#ee-model').onkeydown = $('#ee-qty').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#ee-save').click(); } if (e.key === 'Escape') { e.stopPropagation(); $('#ee-x').click(); } };
    }
    if ($('#add-open')) $('#add-open').onclick = () => { S.eqAdding = true; S.eqEdit = null; renderPanel(); };
    if ($('#add-form')) {
      const fillAdd = () => { $('#dl-add').innerHTML = S.catalog.filter(c => c.Category === $('#add-cat').value).map(c => `<option value="${esc(c.Model)}">`).join(''); };
      $('#add-cat').onchange = fillAdd; fillAdd(); $('#add-model').focus();
      $('#add-x').onclick = () => { S.eqAdding = false; renderPanel(); };
      $('#add-form').onsubmit = e => { e.preventDefault(); const m = $('#add-model').value.trim(); if (!m) return; items.push({ Category: $('#add-cat').value, Model: m, Qty: $('#add-qty').value }); saveItems(r, items, 'Equipment added'); };
    }
  }
  async function renderHistory(r) {
    $('#pbody').innerHTML = '<div class="loading">Loading history…</div>';
    try {
      const d = await api('history', { roomId: r.RoomID });
      if (S.open !== r.RoomID || S.tab !== 'history') return;
      $('#pbody').innerHTML = d.history.length ? d.history.map(h => `<div class="history-item"><span class="who">${esc(h.User)}</span><span class="when">${esc(h.Timestamp)}</span>
        <div class="what">${esc(h.Action)}${has(h.Field) ? ' · ' + esc(h.Field) : ''}${has(h['Old Value']) || has(h['New Value']) ? `: ${esc(h['Old Value'] || '—')} → ${esc(h['New Value'] || '—')}` : ''}</div></div>`).join('')
        : '<div class="note">No changes recorded for this room yet. Edits made on this site show up here with who made them and when.</div>';
    } catch (e) { $('#pbody').innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  }

  // ------------------------------------------------------------------ catalog page
  function roomsUsing(cat, model) {
    const byRoom = {};
    S.equipment.forEach(e => { if (e.Category === cat && e.Model === model) { const q = e.Qty === '' || e.Qty == null ? null : +e.Qty; const cur = byRoom[e.RoomID]; byRoom[e.RoomID] = cur === undefined ? q : (cur == null || q == null ? cur : cur + q); } });
    return Object.keys(byRoom).map(id => ({ room: S.rooms.find(r => r.RoomID === id), qty: byRoom[id] })).filter(x => x.room).sort((a, b) => cmp(roomName(a.room), roomName(b.room)));
  }
  function renderCatalog() {
    const cats = {};
    S.catalog.forEach(c => { (cats[c.Category] = cats[c.Category] || []).push(c); });
    (S.extraCats || []).forEach(c => { cats[c] = cats[c] || []; });
    const names = Object.keys(cats).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
    let html = `<div class="page-head"><div><h2>Equipment Catalog</h2><p>Click a model to see which rooms have it. Edit renames a model everywhere it's used.</p></div>
      <button class="btn small" id="add-cat">+ Add category</button></div><div id="new-cat"></div>`;
    names.forEach(cat => {
      const items = cats[cat].slice().sort((a, b) => cmp(a.Model, b.Model));
      html += `<section class="cat-section"><h3>${esc(cat)} <small>${items.length} model${items.length === 1 ? '' : 's'}</small></h3><div class="scroll"><table class="t">
        <thead><tr><th>Model</th><th style="width:70px">Rooms</th><th style="width:130px">Last price paid</th><th></th></tr></thead><tbody>`;
      items.forEach(it => {
        const k = cat + '||' + it.Model, using = roomsUsing(cat, it.Model), open = S.catOpen.has(k);
        const price = has(it['Last Price Paid']) ? '$' + Number(it['Last Price Paid']).toLocaleString() : '—';
        if (S.catEditing === k) {
          html += `<tr><td><input id="ce-model" value="${esc(it.Model)}" aria-label="Model name"></td><td class="num">${using.length}</td>
            <td><input id="ce-price" inputmode="decimal" value="${esc(it['Last Price Paid'])}" aria-label="Last price paid"></td>
            <td class="act"><button class="btn primary small" data-save="${esc(k)}">Save</button> <button class="btn small" data-cancel>Cancel</button></td></tr>`;
        } else {
          html += `<tr><td><button class="model-link" data-toggle="${esc(k)}" aria-expanded="${open}"><span class="caret">▶</span>${esc(it.Model)}</button></td>
            <td class="num">${using.length}</td><td class="num">${price}</td><td class="act"><button class="btn small" data-edit="${esc(k)}">Edit</button></td></tr>`;
        }
        if (open) html += `<tr class="where"><td colspan="4">${using.length ? `<div class="chips">${using.map(u => `<button class="room-chip" data-room="${esc(u.room.RoomID)}">${esc(roomName(u.room))}<span class="q">×${u.qty == null ? '?' : u.qty}</span></button>`).join('')}</div>` : '<span style="opacity:.6">No rooms have this model.</span>'}</td></tr>`;
      });
      if (S.catAdding === cat) html += `<tr><td><input id="cn-model" placeholder="Model name" aria-label="New model name"></td><td class="num">0</td><td><input id="cn-price" inputmode="decimal" placeholder="0" aria-label="Last price paid"></td>
        <td class="act"><button class="btn primary small" data-create="${esc(cat)}">Add</button> <button class="btn small" data-cancel>Cancel</button></td></tr>`;
      html += `</tbody></table></div>${S.catAdding === cat ? '' : `<button class="btn small" style="margin-top:8px" data-add="${esc(cat)}">+ Add model</button>`}</section>`;
    });
    const main = $('#main'); main.innerHTML = html;
    $$('[data-toggle]', main).forEach(b => b.onclick = () => { const k = b.dataset.toggle; S.catOpen.has(k) ? S.catOpen.delete(k) : S.catOpen.add(k); renderCatalog(); });
    $$('[data-edit]', main).forEach(b => b.onclick = () => { S.catEditing = b.dataset.edit; S.catAdding = null; renderCatalog(); $('#ce-model').focus(); });
    $$('[data-cancel]', main).forEach(b => b.onclick = () => { S.catEditing = null; S.catAdding = null; renderCatalog(); });
    $$('[data-add]', main).forEach(b => b.onclick = () => { S.catAdding = b.dataset.add; S.catEditing = null; renderCatalog(); $('#cn-model').focus(); });
    $$('[data-room]', main).forEach(b => b.onclick = () => { const r = S.rooms.find(x => x.RoomID === b.dataset.room); openRoom(r); S.tab = 'equipment'; renderPanel(); });
    $$('[data-save]', main).forEach(b => b.onclick = async () => {
      const [cat, oldModel] = b.dataset.save.split('||');
      await saveCatalog({ category: cat, oldModel, model: $('#ce-model').value.trim(), price: $('#ce-price').value.replace(/[$,]/g, '').trim() });
    });
    $$('[data-create]', main).forEach(b => b.onclick = async () => {
      const m = $('#cn-model').value.trim(); if (!m) { toast('Enter a model name', true); return; }
      await saveCatalog({ category: b.dataset.create, oldModel: null, model: m, price: $('#cn-price').value.replace(/[$,]/g, '').trim() });
    });
    $('#add-cat').onclick = () => {
      $('#new-cat').innerHTML = `<form class="inline-form" id="nc"><label>New category name<input id="nc-name" placeholder="e.g. Wireless Presentation Hub" required></label>
        <button class="btn primary small" type="submit">Create category</button><button class="btn small" type="button" id="nc-x">Cancel</button></form>`;
      $('#nc-x').onclick = () => { $('#new-cat').innerHTML = ''; };
      $('#nc').onsubmit = e => { e.preventDefault(); const n = $('#nc-name').value.trim(); if (!n) return; S.extraCats = (S.extraCats || []).concat(n); S.catAdding = n; renderCatalog(); $('#cn-model').focus(); };
    };
  }
  async function saveCatalog(p) {
    try {
      const d = await api('saveCatalogItem', p);
      S.catalog = d.catalog; if (d.equipment) S.equipment = d.equipment;
      S.catEditing = null; S.catAdding = null; toast('Catalog saved'); renderCatalog();
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ reports page
  // ------------------------------------------------------------------ export helpers
  function stamp() { return new Date().toISOString().slice(0, 10); }
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportCSV(name, headers, rows) {
    const q = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const csv = [headers].concat(rows).map(r => r.map(q).join(',')).join('\r\n');
    saveBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), name + ' ' + stamp() + '.csv');
  }
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; sc.onload = res; sc.onerror = () => rej(new Error('Could not load the Excel exporter. Try CSV instead.')); document.head.appendChild(sc); });
  }
  async function exportXLSX(name, sheets) { // sheets: [{name, headers, rows}]
    try {
      await loadXLSX();
      const wb = XLSX.utils.book_new();
      sheets.forEach(sh => {
        const ws = XLSX.utils.aoa_to_sheet([sh.headers].concat(sh.rows));
        ws['!cols'] = sh.headers.map((h, i) => ({ wch: Math.min(48, Math.max(String(h).length, ...sh.rows.slice(0, 300).map(r => String(r[i] == null ? '' : r[i]).length)) + 2) }));
        XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
      });
      XLSX.writeFile(wb, name + ' ' + stamp() + '.xlsx');
    } catch (e) { toast(e.message, true); }
  }
  function exportButtons(id) { return `<span style="display:flex;gap:8px"><button class="btn small" id="${id}-xlsx">Export Excel</button><button class="btn small" id="${id}-csv">Export CSV</button></span>`; }
  function tableHtml(headers, rows, numCols) {
    numCols = numCols || [];
    return `<div class="scroll"><table class="t"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r =>
      `<tr>${r.map((v, i) => `<td class="${numCols.includes(i) ? 'num' : ''}">${i === 0 && r._id ? `<button class="model-link" data-room="${esc(r._id)}">${esc(v)}</button>` : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function seats(r) { const n = parseInt(String(r['Seating Capacity'] || '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }

  // ------------------------------------------------------------------ reports page
  function renderReports() {
    const cats = Array.from(new Set(S.catalog.map(c => c.Category).concat(S.equipment.map(e => e.Category)))).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
    S.rp = S.rp || { cat: cats[0] || '', model: '', ctl: 'all' };
    S.rpOpen = S.rpOpen || {};
    const sec = (key, title, body, exp) => `<details class="report rp-sec" data-sec="${key}" ${S.rpOpen[key] ? 'open' : ''}>
        <summary><span class="rp-title">${title}</span><span class="rp-count" id="cnt-${key}"></span></summary>
        <div class="rp-body"><div style="display:flex;justify-content:flex-end;margin-bottom:10px">${exportButtons(exp)}</div>${body}</div></details>`;
    $('#main').innerHTML = `<div class="page-head"><div><h2>Reports</h2><p>Click a report to open or close it.</p></div></div>` +
      sec('eq', 'Which rooms have this equipment?', `<div class="controls">
          <select class="dd" id="rp-cat" aria-label="Category">${cats.map(c => `<option ${c === S.rp.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <select class="dd" id="rp-model" aria-label="Model"></select>
          <select class="dd" id="rp-ctl" aria-label="Room type"><option value="all">All rooms</option><option value="ctl">CTL-supported rooms</option><option value="non">Non-CTL rooms</option></select>
        </div><div id="rp-out"></div>`, 'eq') +
      sec('pl', 'Planned upgrades', '<div id="rp-plan"></div>', 'pl') +
      sec('lc', 'Lifecycle refresh candidates', `<p style="font-size:12.5px;opacity:.75;margin:0 0 10px">Rooms with a planned update year are left off this list and shown under Planned upgrades.</p>
        <div class="controls"><label style="font-size:12.5px;display:flex;gap:8px;align-items:center">Equipment info older than
          <input id="rp-year" type="number" value="${new Date().getFullYear() - STALE}" style="width:84px;padding:6px 8px;border:1px solid var(--line-strong);border-radius:3px;background:var(--card)"></label></div>
        <div id="rp-life"></div>`, 'lc');
    $$('.rp-sec').forEach(d => d.addEventListener('toggle', () => { S.rpOpen[d.dataset.sec] = d.open; }));
    $('#rp-ctl').value = S.rp.ctl;
    const eqRows = () => {
      const byId = {}; S.rooms.forEach(r => byId[r.RoomID] = r);
      const rows = [];
      S.equipment.forEach(e => {
        if (e.Category !== S.rp.cat || (S.rp.model && e.Model !== S.rp.model)) return;
        const r = byId[e.RoomID]; if (!r) return;
        if (S.rp.ctl === 'ctl' && !isCTL(r)) return; if (S.rp.ctl === 'non' && isCTL(r)) return;
        const row = [r.Building, r.Room, r.Zone || '', isCTL(r) ? 'CTL' : 'Non-CTL', r['Record Type'] || '', e.Model, e.Qty === '' || e.Qty == null ? '' : +e.Qty];
        row._id = r.RoomID; rows.push(row);
      });
      return rows.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[5], b[5]));
    };
    const EQH = ['Building', 'Room', 'Zone', 'CTL', 'Record Type', 'Model', 'Qty'];
    const fillModels = () => {
      const models = Array.from(new Set(S.equipment.filter(e => e.Category === S.rp.cat).map(e => e.Model))).sort(cmp);
      if (S.rp.model && !models.includes(S.rp.model)) S.rp.model = '';
      $('#rp-model').innerHTML = `<option value="">Any model</option>` + models.map(m => `<option ${m === S.rp.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
      out();
    };
    const out = () => {
      const rows = eqRows();
      let a = 0, b = 0, unk = 0;
      rows.forEach(r => { if (r[6] === '') unk++; else if (r[3] === 'CTL') a += r[6]; else b += r[6]; });
      const rooms = new Set(rows.map(r => r._id)).size;
      $('#cnt-eq').textContent = `${S.rp.cat}${S.rp.model ? ' · ' + S.rp.model : ''} · ${rooms} rooms`;
      $('#rp-out').innerHTML = `<div class="tiles" style="margin-bottom:14px"><div><div class="num">${rooms}</div><div class="lbl">rooms</div></div>
        <div><div class="num">${a}</div><div class="lbl">units in CTL rooms</div></div><div><div class="num">${b}</div><div class="lbl">units in non-CTL rooms</div></div>
        ${unk ? `<div><div class="num">${unk}</div><div class="lbl">entries with no count</div></div>` : ''}</div>` +
        (rows.length ? tableHtml(EQH, rows, [6]) : '<div class="note">No rooms match.</div>');
      $$('#rp-out [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    };
    const eqName = () => 'Equipment - ' + S.rp.cat + (S.rp.model ? ' - ' + S.rp.model : '');
    $('#eq-csv').onclick = () => exportCSV(eqName(), EQH, eqRows());
    $('#eq-xlsx').onclick = () => exportXLSX(eqName(), [{ name: S.rp.cat || 'Equipment', headers: EQH, rows: eqRows() }]);
    const LCH = ['Building', 'Room', 'Zone', 'CTL', 'Equipment Info As Of', 'Latest Update'];
    const lcRows = () => {
      const y = +$('#rp-year').value || 0;
      return S.rooms.filter(r => r['Record Type'] !== 'Contact Info Only' && !plannedYear(r) && asOfYear(r['Equipment Info As Of']) && asOfYear(r['Equipment Info As Of']) < y)
        .sort((a, b) => String(a['Equipment Info As Of']).localeCompare(String(b['Equipment Info As Of'])))
        .map(r => { const row = [r.Building, r.Room, r.Zone || '', isCTL(r) ? 'CTL' : 'Non-CTL', r['Equipment Info As Of'], r['Latest Update'] || '']; row._id = r.RoomID; return row; });
    };
    const life = () => {
      const rows = lcRows();
      $('#cnt-lc').textContent = rows.length + ' rooms';
      $('#rp-life').innerHTML = `<p style="font-size:12.5px;margin:0 0 10px">${rows.length} rooms, oldest first.</p>` + (rows.length ? tableHtml(LCH, rows) : '');
      $$('#rp-life [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    };
    $('#lc-csv').onclick = () => exportCSV('Lifecycle refresh candidates', LCH, lcRows());
    $('#lc-xlsx').onclick = () => exportXLSX('Lifecycle refresh candidates', [{ name: 'Lifecycle', headers: LCH, rows: lcRows() }]);
    const PLH = ['Building', 'Room', 'Zone', 'CTL', 'Planned Update Year', 'Funding Source', 'Funding Status', 'Equipment Info As Of'];
    const plRows = () => S.rooms.filter(r => plannedYear(r)).sort((a, b) => plannedYear(a) - plannedYear(b) || cmp(a.Building, b.Building) || cmp(a.Room, b.Room))
      .map(r => { const row = [r.Building, r.Room, r.Zone || '', isCTL(r) ? 'CTL' : 'Non-CTL', plannedYear(r), r['Funding Source'] || '', r['Funding Status'] || '', r['Equipment Info As Of'] || '']; row._id = r.RoomID; return row; });
    const pr = plRows();
    $('#cnt-pl').textContent = pr.length + ' rooms';
    $('#rp-plan').innerHTML = pr.length ? tableHtml(PLH, pr) : '<div class="note">No planned upgrades. Set a Planned Update Year and Funding Status on a room to add it here.</div>';
    $$('#rp-plan [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    $('#pl-csv').onclick = () => exportCSV('Planned upgrades', PLH, plRows());
    $('#pl-xlsx').onclick = () => exportXLSX('Planned upgrades', [{ name: 'Planned upgrades', headers: PLH, rows: plRows() }]);
    $('#rp-cat').onchange = e => { S.rp.cat = e.target.value; S.rp.model = ''; fillModels(); };
    $('#rp-model').onchange = e => { S.rp.model = e.target.value; out(); };
    $('#rp-ctl').onchange = e => { S.rp.ctl = e.target.value; out(); };
    $('#rp-year').oninput = life;
    fillModels(); life();
  }

  // ------------------------------------------------------------------ zones page
  function renderZones() {
    const zones = S.zones.slice().sort((a, b) => cmp(a.Zone, b.Zone));
    const names = zones.map(z => z.Zone);
    const ctlIn = z => S.rooms.filter(r => isCTL(r) && String(r.Zone || '').trim().toLowerCase() === String(z).trim().toLowerCase()).sort((a, b) => cmp(a.Building, b.Building) || cmp(a.Room, b.Room));
    const noZone = S.rooms.filter(r => !has(r.Zone)).length;
    const totalRooms = zones.reduce((n, z) => n + ctlIn(z.Zone).length, 0), totalSeats = zones.reduce((n, z) => n + ctlIn(z.Zone).reduce((s, r) => s + seats(r), 0), 0);
    let html = `<div class="page-head"><div><h2>Zones</h2><p>Each room's CTL contact comes from its zone. Change a technician here and every room in that zone, CTL or non-CTL, shows the new person. The backup zone's technician is listed as who to call if the first person is unavailable.</p></div>
      <span style="display:flex;gap:8px;flex-wrap:wrap">${exportButtons('zn')}<button class="btn primary small" id="zn-add">+ Add zone</button></span></div>
      <div class="tiles" style="margin-bottom:18px"><div><div class="num">${totalRooms}</div><div class="lbl">CTL-supported rooms</div></div><div><div class="num">${totalSeats.toLocaleString()}</div><div class="lbl">seats in CTL rooms</div></div>
      ${noZone ? `<div><div class="num">${noZone}</div><div class="lbl">rooms with no zone set</div></div>` : ''}</div>`;
    const list = zones.slice(); if (S.zoneEditing === '__new') list.push({ Zone: '', 'CTL Technician': '', Email: '', Phone: '', 'Backup Zone': '', _new: true });
    list.forEach(z => {
      const rooms = z._new ? [] : ctlIn(z.Zone), seatSum = rooms.reduce((n, r) => n + seats(r), 0);
      const all = z._new ? 0 : S.rooms.filter(r => String(r.Zone || '').trim().toLowerCase() === String(z.Zone).trim().toLowerCase()).length;
      const key = z._new ? '__new' : z.Zone;
      const b = zones.find(x => x.Zone === z['Backup Zone']);
      html += `<section class="report">`;
      if (S.zoneEditing === key) {
        html += `<form class="inline-form" id="zf" style="margin:0">
          <label>Zone<input id="zf-zone" value="${esc(z.Zone)}" required></label>
          <label>CTL technician<input id="zf-name" value="${esc(z['CTL Technician'])}"></label>
          <label>Email<input id="zf-email" type="email" value="${esc(z.Email)}"></label>
          <label>Phone<input id="zf-phone" value="${esc(z.Phone)}"></label>
          <label>Backup zone<select id="zf-backup"><option value=""></option>${names.filter(n => n !== z.Zone).map(n => `<option ${n === z['Backup Zone'] ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <button class="btn primary small" type="submit">Save</button><button class="btn small" type="button" id="zf-x">Cancel</button></form>
          ${z._new ? '' : `<p style="font-size:12px;opacity:.7;margin:8px 0 0">Renaming the zone also renames it on all ${all} rooms in it.</p>`}`;
      } else {
        html += `<div class="page-head" style="margin-bottom:8px"><div><h3 style="margin:0">${esc(z.Zone)} <span style="font-family:var(--font-body);font-size:12px;font-weight:400;opacity:.7">${rooms.length} CTL rooms · ${seatSum.toLocaleString()} seats · ${all} rooms in zone</span></h3>
          <p style="opacity:.9">${has(z['CTL Technician']) ? `<b>${esc(z['CTL Technician'])}</b> · ${esc(z.Email || '')} · ${esc(z.Phone || '')}` : '<i>No technician set</i>'}<br>
          Backup: ${b ? `${esc(b.Zone)} zone, ${esc(b['CTL Technician'] || 'no technician')}${has(b.Phone) ? ' · ' + esc(b.Phone) : ''}` : '<i>not set</i>'}</p></div>
          <button class="btn small" data-zedit="${esc(z.Zone)}">Edit</button></div>
          <details><summary style="cursor:pointer;font-size:12.5px">Show ${rooms.length} CTL rooms</summary><div style="margin-top:10px">${
            rooms.length ? tableHtml(['Building', 'Room', 'Room Type', 'Seats'], rooms.map(r => { const row = [r.Building, r.Room, r['Room Type'] || '', seats(r) || '']; row._id = r.RoomID; return row; }), [3]) : '<div class="note">No CTL-supported rooms in this zone.</div>'}</div></details>`;
      }
      html += `</section>`;
    });
    $('#main').innerHTML = html;
    $$('[data-zedit]').forEach(x => x.onclick = () => { S.zoneEditing = x.dataset.zedit; renderZones(); });
    $$('#main [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    $('#zn-add').onclick = () => { S.zoneEditing = '__new'; renderZones(); };
    if ($('#zf')) {
      $('#zf-x').onclick = () => { S.zoneEditing = null; renderZones(); };
      $('#zf').onsubmit = async e => {
        e.preventDefault();
        const zone = { Zone: $('#zf-zone').value.trim(), 'CTL Technician': $('#zf-name').value.trim(), Email: $('#zf-email').value.trim(), Phone: $('#zf-phone').value.trim(), 'Backup Zone': $('#zf-backup').value };
        try {
          const d = await api('saveZone', { zone, originalZone: S.zoneEditing === '__new' ? null : S.zoneEditing });
          S.zones = d.zones; if (d.rooms) S.rooms = d.rooms; S.zoneEditing = null; toast('Zone saved. Every room in the zone now shows this technician.'); renderZones();
        } catch (err) { toast(err.message, true); }
      };
    }
    const ZH = ['Zone', 'CTL Technician', 'Technician Email', 'Technician Phone', 'Backup Zone', 'Building', 'Room', 'Room Type', 'Seats'];
    const zRows = () => { const rows = []; zones.forEach(z => ctlIn(z.Zone).forEach(r => rows.push([z.Zone, z['CTL Technician'] || '', z.Email || '', z.Phone || '', z['Backup Zone'] || '', r.Building, r.Room, r['Room Type'] || '', seats(r) || '']))); return rows; };
    const sumRows = () => zones.map(z => { const rs = ctlIn(z.Zone); return [z.Zone, z['CTL Technician'] || '', z.Email || '', z.Phone || '', z['Backup Zone'] || '', rs.length, rs.reduce((n, r) => n + seats(r), 0)]; });
    const SH = ['Zone', 'CTL Technician', 'Email', 'Phone', 'Backup Zone', 'CTL Rooms', 'Seats'];
    $('#zn-csv').onclick = () => exportCSV('CTL rooms by zone', ZH, zRows());
    $('#zn-xlsx').onclick = () => exportXLSX('CTL rooms by zone', [{ name: 'Summary', headers: SH, rows: sumRows() }, { name: 'CTL rooms', headers: ZH, rows: zRows() }]);
  }

  // ------------------------------------------------------------------ users page
  async function renderUsers() {
    const main = $('#main');
    if (!S.users) {
      main.innerHTML = '<div class="loading">Loading users…</div>';
      try { S.users = (await api('listUsers')).users; } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    }
    const roles = ['Admin', 'Technician', 'Student'];
    const row = (u, i) => S.userEditing === i
      ? `<tr><td><input id="ue-email" value="${esc(u.Email)}" aria-label="Email"></td><td><input id="ue-name" value="${esc(u.Name)}" aria-label="Name"></td>
          <td><select id="ue-role" aria-label="Role">${roles.map(r => `<option ${u.Role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
          <td><select id="ue-active" aria-label="Active"><option ${u.Active !== 'No' ? 'selected' : ''}>Yes</option><option ${u.Active === 'No' ? 'selected' : ''}>No</option></select></td>
          <td class="act"><button class="btn primary small" id="ue-save">Save</button> <button class="btn small" id="ue-x">Cancel</button></td></tr>`
      : `<tr style="${u.Active === 'No' ? 'opacity:.55' : ''}"><td>${esc(u.Email)}</td><td>${esc(u.Name)}</td><td>${esc(u.Role)}</td><td>${u.Active === 'No' ? 'No' : 'Yes'}</td>
          <td class="act"><button class="btn small" data-ue="${i}">Edit</button></td></tr>`;
    const list = S.users.slice();
    if (S.userEditing === 'new') list.push({ Email: '', Name: '', Role: 'Student', Active: 'Yes', _new: true });
    main.innerHTML = `<div class="page-head"><div><h2>Users</h2><p>People sign in with the Google account for this email. Set Active to No to turn off someone's access without deleting them. You can also edit the Users tab in the Google Sheet directly.</p></div>
      ${S.userEditing === 'new' ? '' : '<button class="btn primary small" id="u-add">+ Add person</button>'}</div>
      <div class="scroll"><table class="t"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead>
      <tbody>${list.map((u, i) => row(u, u._new ? 'new' : i)).join('')}</tbody></table></div>`;
    if ($('#u-add')) $('#u-add').onclick = () => { S.userEditing = 'new'; renderUsers(); };
    $$('[data-ue]').forEach(b => b.onclick = () => { S.userEditing = +b.dataset.ue; renderUsers(); });
    if ($('#ue-x')) $('#ue-x').onclick = () => { S.userEditing = null; renderUsers(); };
    if ($('#ue-save')) $('#ue-save').onclick = async () => {
      const orig = S.userEditing === 'new' ? null : S.users[S.userEditing].Email;
      const user = { Email: $('#ue-email').value.trim(), Name: $('#ue-name').value.trim(), Role: $('#ue-role').value, Active: $('#ue-active').value };
      try { S.users = (await api('saveUser', { user, originalEmail: orig })).users; S.userEditing = null; toast('User saved'); renderUsers(); }
      catch (e) { toast(e.message, true); }
    };
  }

  // ------------------------------------------------------------------ boot
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open && !S.editField && S.eqEdit == null && !S.eqAdding) closePanel(); });
  (async function boot() {
    if (!DEMO) {
      let t = null; try { t = sessionStorage.getItem('idToken'); } catch (e) {}
      if (t && tokenExp(t) > Date.now() + 60000) { S.token = t; await loadSession(); if (!S.user) await loadPublic(); }
      else await loadPublic();
      initGoogle();
    } else {
      await loadPublic();
    }
  })();
})();
