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
      ['Equipment Info As Of', 'text'], ['Latest Update', 'text'], ['Planned Update Year', 'text'], ['Funding Status', ['Funding Requested', 'Funding Approved']], ['Funding Source', ['STF', 'Client Funded']], ['Refresh Plan', ["Won't be updated"]], ['Photos URL', 'text', 'Photos link (view only, public)'], ['Photos Upload URL', 'text', 'Photos link (can edit, for adding photos)'], ['GVE Room ID', 'text']]],
  ];
  const CONTACTS = [
    ['AV Support', 'AV Support Contact', 'AV Support Email', 'AV Support Phone'],
    ['Computer Support', 'Computer Support Contact', 'Computer Support Email', 'Computer Support Phone'],
    ['Department Contact', 'Department Contact', 'Department Contact Email', 'Department Contact Phone'],
  ];
  const CATEGORY_ORDER = ['Instructor Computer', 'Cabinet', 'Projector', 'Wall Display', 'Touchpanel', 'Controller', 'Switcher',
    'Lavalier Mic', 'Handheld Mic', 'Mic Receiver', 'Document Camera', 'Blu-ray / DVD Player', 'Amplifier', 'Speaker',
    'Power Conditioner', 'HDMI Extender', 'Video Conferencing'];

  const S = { projects: [], pj: { view: 'board', q: '', mode: 'stf', fy: '', fund: '', phase: '' }, lists: {}, showArchived: false, catCatOpen: new Set(), zones: [], user: null, role: null, token: null, rooms: [], equipment: [], catalog: [], users: null,
    page: 'rooms', q: '', building: '', ctlOnly: false, limit: 120, open: null, tab: null,
    catOpen: new Set(), catEditing: null, catAdding: null, addingRoom: false };

  // ------------------------------------------------------------------ utils
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const has = v => v !== undefined && v !== null && String(v).trim() !== '';
  const canEdit = () => EDIT_ROLES.includes(S.role);
  const canView = () => EDIT_ROLES.includes(S.role);   // equipment, catalog and history are staff-only
  const roleLabel = r => r === 'Viewer' ? 'UGA Employee' : r;   // "Viewer" on the Users tab
  const isArchived = r => String(r.Archived || '').trim().toLowerCase() === 'yes';
  const LIST_FIELDS = ['Department', 'College', 'Primary Support Unit'];
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
  // "Won't be updated" takes a room off the lifecycle refresh list for good (until the field is cleared).
  const wontUpdate = r => has(r['Refresh Plan']);
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
  const WRITE_ACTIONS = ['saveRoom', 'archiveRoom', 'addRoom', 'removeRoom', 'saveEquipment', 'saveCatalogItem', 'deleteCatalogItem', 'saveZone', 'saveUser', 'saveProject', 'deleteProject'];
  async function api(action, payload) {
    const asRole = S.viewAs && S.viewAs !== 'Public' ? S.viewAs : null;
    if (S.viewAs && WRITE_ACTIONS.includes(action)) throw new Error(`You're previewing as ${roleLabel(S.viewAs)}. Switch back to Admin to make changes.`);
    if (DEMO) return DemoAPI.call(action, payload || {}, asRole || S.realRole || S.role);
    if (action === 'public') {
      const res = await fetch(CFG.API_URL + '?action=public');
      return res.json();
    }
    const res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, idToken: S.token }, asRole ? { viewAs: asRole } : {}, payload || {})) });
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
      S.user = d.user; S.role = d.user.role; S.realRole = d.user.realRole || (S.viewAs ? S.realRole : d.user.role); S.rooms = d.rooms; S.equipment = d.equipment || []; S.catalog = d.catalog || []; S.zones = d.zones || [];
      S.lists = d.lists || {}; S.projects = d.projects || [];
      if (!canEdit()) S.page = 'rooms';
      toast(S.viewAs ? `Previewing as ${roleLabel(S.viewAs)}` : `Signed in as ${S.user.name} (${roleLabel(S.role)})`);
    } catch (e) { toast(e.message, true); }
    renderAll();
  }
  function signOut(silent) {
    S.user = null; S.role = null; S.realRole = null; S.viewAs = null; S.token = null; S.equipment = []; S.catalog = []; S.projects = []; S.users = null; S.page = 'rooms';
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
      const admin = S.realRole === 'Admin';
      el.innerHTML = `<span class="user-chip">${esc(S.user.name)} <span class="role-pill">${esc(roleLabel(S.realRole || S.role))}</span></span>
        ${admin ? `<label class="viewas">View as <select id="viewas" aria-label="Preview the site as another role">${[['', 'Admin (me)'], ['Technician', 'Technician'], ['Viewer', 'UGA Employee'], ['Student', 'Student'], ['Public', 'Public']].map(([v, l]) =>
          `<option value="${v}" ${(S.viewAs || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
        ${DEMO ? '' : '<button class="link-btn" id="signout">Sign out</button>'}`;
      if (!DEMO) $('#signout').onclick = () => { signOut(); toast('Signed out'); };
      if (admin) $('#viewas').onchange = e => setViewAs(e.target.value || null);
    } else if (DEMO) {
      el.innerHTML = '';
    } else {
      el.innerHTML = '<div id="gsi-btn"></div>';
      if (window.google && google.accounts) google.accounts.id.renderButton($('#gsi-btn'), { theme: 'outline', size: 'medium', text: 'signin' });
    }
    renderNav();
  }
  // Admin preview: see the site exactly as another role would (read-only).
  async function setViewAs(r) {
    S.viewAs = r; closePanel(); closeProject && closeProject();
    if (r === 'Public') {
      S.role = null; S.equipment = []; S.catalog = []; S.projects = []; S.page = 'rooms';
      try { S.rooms = (await api('public')).rooms || []; } catch (e) { toast(e.message, true); }
      toast('Previewing as Public'); renderAll(); return;
    }
    await loadSession();
  }
  function renderPreviewBar() {
    let bar = $('#preview-bar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'preview-bar'; bar.className = 'preview-bar'; $('#demo-bar').after(bar); }
    bar.hidden = !S.viewAs;
    if (!S.viewAs) return;
    bar.innerHTML = `<span><b>Preview:</b> you're seeing the site as ${S.viewAs === 'Public' ? 'the public (not signed in)' : 'a ' + esc(roleLabel(S.viewAs))}. Changes are turned off.</span><button class="btn small" id="pv-exit">Back to Admin view</button>`;
    $('#pv-exit').onclick = () => setViewAs(null);
  }
  // Staff (technicians and admins) get a left sidebar; everyone else only has the Rooms page, so no menu.
  const ICON = {
    overview: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
    rooms: '<path d="M4 20V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15M15 9h4a1 1 0 0 1 1 1v10M2 20h20M8 8h3M8 12h3M8 16h3"/>',
    projects: '<path d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z"/>',
    catalog: '<path d="M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10"/>',
    reports: '<path d="M4 20h16M7 16v-5M12 16V7M17 16v-8"/>',
    zones: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  };
  const PROJECTOR = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="7" width="19" height="10" rx="2.5"/><circle cx="15.5" cy="12" r="3"/><circle cx="15.5" cy="12" r=".8" fill="currentColor"/><path d="M6 10.5h4M6 13.5h3M6 17v2M18 17v2"/></svg>';
  const PAGE_NAMES = { rooms: 'Rooms', projects: 'Projects', overview: 'Overview', catalog: 'Equipment Catalog', reports: 'Reports', zones: 'Zones', users: 'Users' };
  const icon = k => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  function renderNav() {
    const side = $('#sidebar'), staff = canEdit();
    document.body.classList.toggle('has-sidebar', staff);
    side.hidden = !staff; $('#menu-btn').hidden = !staff; $('#page-tabs').hidden = true;
    if (!staff) { document.body.classList.remove('nav-open'); return; }
    const item = (k, l) => `<button class="nav-item ${S.page === k ? 'active' : ''}" data-nav="${k}">${icon(k)}<span>${l}</span>${k === 'projects' ? `<span class="nav-count">${S.projects.filter(isOpenProject).length}</span>` : ''}</button>`;
    side.innerHTML = `<div class="side-brand"><span class="side-mark">${PROJECTOR}</span><span>${esc(CFG.SITE_TITLE || 'Room Directory')}</span></div>
      <nav class="nav-group">${item('rooms', 'Rooms')}${item('projects', 'Projects')}${item('overview', 'Overview')}</nav>
      <div class="nav-label">Manage</div>
      <nav class="nav-group">${item('catalog', 'Equipment Catalog')}${item('reports', 'Reports')}${item('zones', 'Zones')}${S.role === 'Admin' ? item('users', 'Users') : ''}</nav>`;
    $$('[data-nav]', side).forEach(b => b.onclick = () => { S.page = b.dataset.nav; if (S.page === 'projects') S.pj.view = S.pj.view === 'completed' ? 'board' : S.pj.view; document.body.classList.remove('nav-open'); renderAll(); window.scrollTo(0, 0); });
    $('#menu-btn').onclick = () => document.body.classList.toggle('nav-open');
    $('#scrim').onclick = () => document.body.classList.remove('nav-open');
  }
  function renderDemoBar() {
    const bar = $('#demo-bar');
    if (!DEMO) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<strong>Demo mode</strong><span>Sample data only. Nothing is saved. View as</span>
      <select id="demo-role" aria-label="View as role">${[['Public', 'Public'], ['Student', 'Student'], ['Viewer', 'UGA Employee'], ['Technician', 'Technician'], ['Admin', 'Admin']].map(([v, l]) =>
        `<option value="${v}" ${((S.realRole || S.role || 'Public') === v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    $('#demo-role').onchange = async e => {
      const r = e.target.value;
      S.viewAs = null;
      if (r === 'Public') { S.user = null; S.role = null; S.realRole = null; S.page = 'rooms'; await loadPublic(); }
      else { S.role = r; S.realRole = r; S.user = { name: 'Demo ' + r, email: 'demo@example.com', role: r }; if (!canEdit() && S.page !== 'rooms') S.page = 'rooms'; await loadSession(); }
    };
  }
  // "Manage" groups the staff tools under one top tab, with its own sub-tabs.
  const MANAGE_PAGES = ['catalog', 'reports', 'zones', 'users'];
  function renderManage() {
    S.manageLast = S.page;
    $('#main').innerHTML = '<div id="mg-body"></div>';   // the sidebar lists these pages
    ({ catalog: renderCatalog, reports: renderReports, zones: renderZones, users: renderUsers })[S.page]();
  }
  const subHost = () => $('#mg-body') || $('#main');
  function renderAll() {
    // Header: staff (with the sidebar) see the page they're on; everyone else sees the site name with a projector mark.
    const staffNav = canEdit();
    $('#band-mark').innerHTML = staffNav ? '' : PROJECTOR; $('#band-mark').hidden = staffNav;
    $('#site-eyebrow').textContent = staffNav ? (CFG.SITE_TITLE || 'Campus Room Directory') : 'Center for Teaching and Learning';
    $('#site-title').textContent = staffNav ? (PAGE_NAMES[S.page] || 'Rooms') : String(CFG.SITE_TITLE || 'Campus Room Directory').replace(/^CTL\s+/, '');
    $('#site-sub').textContent = staffNav ? '' : (CFG.SITE_SUBTITLE || '');
    document.title = CFG.SITE_TITLE || 'Campus Room Directory';
    renderAccount(); renderDemoBar(); renderPreviewBar();
    if (S.page === 'overview' && canEdit()) renderOverview();
    else if (S.page === 'projects' && canEdit()) renderProjects();
    else if (MANAGE_PAGES.includes(S.page) && canEdit() && (S.page !== 'users' || S.role === 'Admin')) renderManage();
    else { S.page = 'rooms'; renderRooms(); }
    if (S.open) renderPanel();
  }

  // ------------------------------------------------------------------ rooms page
  function filteredRooms() {
    const q = S.q.trim().toLowerCase();
    const eqByRoom = canView() ? equipIndex() : {};
    return S.rooms.filter(r => {
      if (isArchived(r) && !S.showArchived && !q) return false; // archived rooms still show up when searching
      if (S.building && r.Building !== S.building) return false;
      if (S.ctlOnly && !isCTL(r)) return false;
      if (!q) return true;
      const hay = [r.Building, r.Room, r['Room Type'], r.Department, r.College, r.Zone,
        r['AV Support Contact'], r['Computer Support Contact'], r['CTL Tech'],
        (eqByRoom[r.RoomID] || []).map(e => e.Model).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    }).sort((a, b) => (isCTL(b) - isCTL(a)) || cmp(a.Building, b.Building) || cmp(a.Room, b.Room));   // CTL rooms first, then the rest, each A–Z
  }
  function equipIndex() { const m = {}; S.equipment.forEach(e => { (m[e.RoomID] = m[e.RoomID] || []).push(e); }); return m; }

  function renderRooms() {
    const buildings = Array.from(new Set(S.rooms.map(r => r.Building))).sort(cmp);
    const main = $('#main');
    main.innerHTML = `
      <div class="search-row">
        <input class="search" id="q" type="search" placeholder="Search building, room${canView() ? ', equipment' : ''}${S.role ? ', contact' : ''}…" value="${esc(S.q)}" aria-label="Search">
      </div>
      <div class="controls">
        <select class="dd" id="dd-building" aria-label="Building"><option value="">All buildings</option>${buildings.map(b => `<option ${b === S.building ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        <select class="dd" id="dd-room" aria-label="Room"><option value="">Jump to room…</option></select>
        <button class="chip ${S.ctlOnly ? 'active' : ''}" id="ctl-only">CTL-supported only</button>
        ${S.role ? `<label class="switch"><input type="checkbox" id="show-arch" ${S.showArchived ? 'checked' : ''}><span class="track" aria-hidden="true"></span>Show archived rooms</label>` : ''}
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
    if ($('#show-arch')) $('#show-arch').onchange = e => { S.showArchived = e.target.checked; S.limit = 120; fillRoomDD(); drawGrid(); };
    if ($('#add-room')) $('#add-room').onclick = () => { S.addingRoom = !S.addingRoom; drawAddRoom(); };
    fillRoomDD(); drawAddRoom(); drawGrid();
  }
  function fillRoomDD() {
    const dd = $('#dd-room'); if (!dd) return;
    const list = S.rooms.filter(r => (!S.building || r.Building === S.building) && (S.showArchived || !isArchived(r))).sort((a, b) => cmp(a.Building, b.Building) || cmp(a.Room, b.Room));
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
      if (S.role && S.role !== 'Viewer') {
        if (has(r['AV Support Contact'])) lines.push(`<div><b>AV:</b> ${esc(r['AV Support Contact'])}</div>`);
        if (has(r['Computer Support Contact'])) lines.push(`<div><b>Computer:</b> ${esc(r['Computer Support Contact'])}</div>`);
      } else if (has(r.Department)) lines.push(`<div><b>Department:</b> ${esc(r.Department)}</div>`);
      return `<button class="plaque ${isContactOnly(r) ? 'contact-only' : ''} ${isArchived(r) ? 'archived' : ''}" data-id="${esc(r.RoomID)}">
        <div class="idline">${esc(r.Building)}<br>${esc(r.Room)}</div>
        <div class="tags">${isCTL(r) ? `<span class="tag ctl">${CHECK}CTL</span>` : '<span class="tag nonctl">Non-CTL</span>'}${isArchived(r) ? '<span class="tag arch">Archived</span>' : ''}${canEdit() ? (p => p ? `<span class="tag proj">${esc(p.Phase)}</span>` : '')(projectsFor(r.RoomID).filter(isOpenProject).sort((a, b) => PHASES.indexOf(b.Phase) - PHASES.indexOf(a.Phase))[0]) : ''}</div>
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
    S.tab = canView() ? 'main' : (S.role && S.role !== 'Viewer' ? 'contacts' : 'info');
    S.confirmRemove = false; S.roomEdit = false; S.eqEditAll = false; S.eqDraft = null; S.history = null;
    renderPanel();
  }
  function closePanel() { S.open = null; $('#overlay-root').innerHTML = ''; document.body.style.overflow = ''; }
  function currentRoom() { return S.rooms.find(r => r.RoomID === S.open); }

  function renderPanel() {
    const r = currentRoom(); if (!r) { closePanel(); return; }
    const old = $('.panel'); const keep = old && S.lastPanel === S.open + '|' + S.tab ? old.scrollTop : 0;
    S.lastPanel = S.open + '|' + S.tab;
    const restore = () => { const p = $('.panel'); if (p) p.scrollTop = keep; };
    const tabs = canView() ? [['main', 'Room & support contacts'], ['equipment', 'Equipment'], ['history', 'History']]
      : S.role && S.role !== 'Viewer' ? [['contacts', 'Support contacts'], ['info', 'Room']] : [];
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
    $$('.tab').forEach(t => t.onclick = () => { if ((S.roomEdit || S.eqEditAll) && !confirm('Leave without saving your changes?')) return; S.tab = t.dataset.tab; S.roomEdit = false; S.eqEditAll = false; S.eqDraft = null; renderPanel(); });
    const body = $('#pbody'), foot = $('#pfoot');
    if (S.tab === 'info' || !S.role) { body.innerHTML = infoHtml(r) + ('Photos URL' in r && !has(r['Photos URL']) ? '<div class="note">No photos linked for this room yet.</div>' : ''); return; }
    if (S.tab === 'contacts') { body.innerHTML = (isArchived(r) ? '<div class="note arch"><div><b>Archived room</b></div></div>' : '') + contactsHtml(r); return; }
    const archNote = isArchived(r) ? '<div class="note arch"><div><b>Archived room</b>Hidden from the room list unless "Show archived rooms" is on, and never shown to the public.</div></div>' : '';
    if (S.tab === 'main') { body.innerHTML = (canEdit() && !S.roomEdit ? '<div class="edit-bar"><button class="btn primary small" id="room-edit">✎ Edit room</button></div>' : '') + archNote + (S.roomEdit ? '' : roomProjectsHtml(r)) + contactsEditHtml(r) + roomEditHtml(r); wireProjectLinks(body); foot.innerHTML = canEdit() || S.role === 'Admin' ? roomFoot() : ''; wireFieldEdits(r); if (foot.innerHTML) wireRoomFoot(r); restore(); return; }
    if (S.tab === 'equipment') { renderEquipmentTab(r); restore(); return; }
    if (S.tab === 'equipment') { renderEquipmentTab(r); return; }
    if (S.tab === 'history') { renderHistory(r); return; }
  }
  // Read-only room view for the public, students' Room tab and UGA Employees. Shows only the fields the server sent.
  function infoHtml(r) {
    const row = (k, f, link) => f in r ? `<div class="row"><span class="k">${k}</span><span class="v ${has(r[f]) ? '' : 'none'}">${!has(r[f]) ? 'Not recorded'
      : link && /^https?:/i.test(r[f]) ? `<a href="${esc(r[f])}" target="_blank" rel="noopener">${esc(String(r[f]).replace(/^https?:\/\//, ''))} ↗</a>` : esc(r[f])}</span></div>` : '';
    let html = '<div class="section-title">Room</div>' + row('Building', 'Building') + row('Room', 'Room') + row('Building number', 'Building Number') + row('Room type', 'Room Type') + row('Zone', 'Zone');
    html += '<div class="section-title">Department and support</div>' + row('Department', 'Department') + row('College', 'College') + row('Primary support unit', 'Primary Support Unit') + row('Help / ticket website', 'Help / Ticket Website', true);
    const details = row('Reservations', 'Reservations') + row('Seating capacity', 'Seating Capacity') + row('Square footage', 'Square Footage') + row('Seating configuration', 'Seating Configuration') + row('Floor type', 'Floor Type') + row('PC port', 'PC Port') + row('AV port', 'AV Port');
    if (details) html += '<div class="section-title">Room details</div>' + details;
    return html;
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
      </div>`;
  }
  function contactsHtml(r) {
    let html = '<div class="section-title">Support contacts</div>';
    let any = false;
    const ctl = ctlCard(r, false);
    const dept = [['Department', r.Department], ['College', r.College], ['Primary support unit', r['Primary Support Unit']]].filter(x => has(x[1]));
    if (dept.length) html += `<div class="contact"><div class="role">Department</div>${dept.map(([k, v]) => `<div class="kv"><span class="kv-k">${k}</span><span class="kv-v">${esc(v)}</span></div>`).join('')}</div>`;
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
    if (kind === 'list') {
      const opts = (S.lists[field] || []).slice(); if (has(val) && !opts.includes(String(val))) opts.unshift(String(val));
      return `<select id="${id}" data-field="${esc(field)}" data-list="1"><option value=""></option>${opts.map(o => `<option ${String(val) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        ${S.role === 'Admin' ? '<option value="__new__">+ Add a new name…</option>' : ''}</select>`;
    }
    return `<input id="${id}" data-field="${esc(field)}" value="${esc(val)}" placeholder="—">`;
  }
  // Read-only rows. In edit mode (one Edit button at the top of the room) every field becomes an input at once.
  function fieldRow(r, field, label, kind) {
    const v = r[field];
    if (kind === 'locked') return `<div class="row"><span class="k">${esc(label)}</span><span class="v ${has(v) ? '' : 'none'}">${has(v) ? esc(v) : 'Not recorded'}</span>${S.roomEdit ? '<span class="lock-note" title="To change this, add a new room">Fixed</span>' : ''}</div>`;
    if (LIST_FIELDS.includes(field)) kind = 'list';
    if (S.roomEdit && canEdit()) return `<div class="row editing"><label class="k" for="f-${field.replace(/\W+/g, '-')}">${esc(label)}</label><span class="edit-wrap">${input(field, v, kind)}</span></div>`;
    const shown = !has(v) ? 'Not recorded' : (field === 'Photos URL' || field === 'Photos Upload URL' || field === 'Help / Ticket Website') ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v);
    return `<div class="row"><span class="k">${esc(label)}</span><span class="v ${has(v) ? '' : 'none'}">${shown}</span></div>`;
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
    if ($('#room-edit')) $('#room-edit').onclick = () => { S.roomEdit = true; S.confirmRemove = false; renderPanel(); const el = $('#pbody [data-field]'); if (el) el.focus(); };
    if (!S.roomEdit) return;
    // "+ Add a new name…" in a list field turns that dropdown into a text box (admins only)
    $$('#pbody select[data-list]').forEach(el => el.onchange = () => {
      if (el.value !== '__new__') return;
      const f = el.dataset.field;
      el.outerHTML = `<input id="${el.id}" data-field="${esc(f)}" placeholder="New ${esc(f)} name">`;
      $('#' + el.id).focus();
    });
    $$('#pbody [data-field]').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); cancelRoomEdit(); } }));
  }
  function cancelRoomEdit() { S.roomEdit = false; renderPanel(); }
  async function saveRoomEdit(r) {
    const changes = {};
    for (const el of $$('#pbody [data-field]')) {
      const f = el.dataset.field, v = el.value.trim();
      if (v === '__new__') { toast(`Type the new ${f} name first`, true); el.focus(); return; }
      if (String(r[f] == null ? '' : r[f]) !== v) changes[f] = v;
    }
    if (!Object.keys(changes).length) { cancelRoomEdit(); toast('No changes'); return; }
    try {
      const d = await api('saveRoom', { roomId: r.RoomID, changes });
      Object.assign(r, d.room); if (d.lists) S.lists = d.lists; S.roomEdit = false;
      toast(`Saved ${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? '' : 's'}`); renderAll();
    } catch (e) { toast(e.message, true); }
  }
  function roomFoot() {
    if (S.roomEdit) return `<div class="save-bar edit-foot"><span style="font-size:12.5px;font-weight:600">Editing this room</span>
      <span style="display:flex;gap:8px"><button class="btn small" id="re-cancel">Cancel</button><button class="btn primary small" id="re-save">Save changes</button></span></div>`;
    if (S.confirmRemove) return `<div class="save-bar"><div class="confirm warn-box"><b>Remove this room permanently?</b> This can't be undone from the website. If you only want to hide it, use Archive instead.
      <span style="display:flex;gap:8px;margin-top:8px"><button class="btn danger small" id="rm-yes">Yes, remove permanently</button><button class="btn small" id="rm-no">Cancel</button></span></div></div>`;
    const r = currentRoom();
    return `<div class="save-bar"><span style="display:flex;gap:8px;flex-wrap:wrap">${canEdit() ? '<button class="btn danger small" id="rm">Remove room</button>' : ''}
      ${S.role === 'Admin' ? `<button class="btn small" id="arch">${isArchived(r) ? 'Unarchive room' : 'Archive room'}</button>` : ''}</span>
      ${canEdit() ? '<button class="btn primary small" id="room-edit-2">✎ Edit room</button>' : ''}</div>`;
  }
  function wireRoomFoot(r) {
    if (S.roomEdit) { $('#re-cancel').onclick = cancelRoomEdit; $('#re-save').onclick = () => saveRoomEdit(r); return; }
    if ($('#room-edit-2')) $('#room-edit-2').onclick = () => $('#room-edit').click();
    if (S.confirmRemove) {
      $('#rm-no').onclick = () => { S.confirmRemove = false; renderPanel(); };
      $('#rm-yes').onclick = async () => {
        try { await api('removeRoom', { roomId: r.RoomID }); S.rooms = S.rooms.filter(x => x.RoomID !== r.RoomID); closePanel(); toast('Room removed'); renderAll(); }
        catch (e) { toast(e.message, true); }
      };
      return;
    }
    if ($('#rm')) $('#rm').onclick = () => { S.confirmRemove = true; renderPanel(); };
    if ($('#arch')) $('#arch').onclick = async () => {
      try { const d = await api('archiveRoom', { roomId: r.RoomID, archived: !isArchived(r) }); Object.assign(r, d.room); toast(isArchived(r) ? 'Room archived' : 'Room unarchived'); renderAll(); }
      catch (e) { toast(e.message, true); }
    };
  }

  // equipment tab: read-only list, Edit per item, "+ Add equipment" opens a form
  function roomItems(r) { return S.equipment.filter(e => e.RoomID === r.RoomID).map(e => ({ Category: e.Category, Model: e.Model, Qty: e.Qty })); }
  async function saveItems(r, items, msg) {
    const clean = items.filter(i => String(i.Model).trim()).map(i => ({ Category: i.Category, Model: String(i.Model).trim(), Qty: i.Qty === '' || i.Qty == null ? '' : Number(i.Qty) }));
    try {
      const d = await api('saveEquipment', { roomId: r.RoomID, items: clean });
      S.equipment = S.equipment.filter(e => e.RoomID !== r.RoomID).concat(d.equipment);
      if (d.catalog) S.catalog = d.catalog;
      toast(msg); renderPanel();
    } catch (e) { toast(e.message, true); }
  }
  function renderEquipmentTab(r) {
    const items = roomItems(r);
    let html = '';
    if (isStale(r)) html += `<div class="note stale"><div><b>Equipment information as of ${esc(r['Equipment Info As Of'])}</b>CTL's last install or update in this room was more than ${STALE} years ago. This list may not match what is in the room now.${plannedYear(r) ? ' ' + esc(plannedText(r)) + '.' : ''}</div></div>`;
    else if (plannedYear(r)) html += `<div class="note"><div><b>${esc(plannedText(r))}</b></div></div>`;
    const cp = canEdit() ? committedProject(r) : null;
    if (cp) html += `<div class="note"><div><b>Project: ${esc(cp.Phase)}${has(cp['STF Year']) ? ' (' + esc(cp['STF Year']) + ')' : ''}</b><button class="model-link" data-project="${esc(cp.ProjectID)}">${esc(cp.Title)}</button> ${ticketLink(cp)}</div></div>`;
    if (wontUpdate(r)) html += `<div class="note"><div><b>Won't be updated</b>This room is left off the lifecycle refresh list.</div></div>`;
    if (isContactOnly(r)) html += '<div class="note"><div><b>Contact-only room</b>This list is only visible to technicians and admins.</div></div>';
    const allCats = Array.from(new Set(CATEGORY_ORDER.concat(S.catalog.map(c => c.Category)))).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
    const qtyText = q => q === '' || q == null ? '?' : esc(q);
    if (S.eqEditAll) {
      // edit mode: every item is editable; nothing is saved until "Save changes"
      const d = S.eqDraft;
      html += `<div class="eq-edit-head">Change models or counts, remove items, or add new ones. Nothing is saved until you click <b>Save changes</b>.</div>`;
      const cats = Array.from(new Set(d.map(i => i.Category))).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
      cats.forEach(cat => {
        const lid = 'dl-' + cat.replace(/\W+/g, '-');
        html += `<div class="eq-group"><div class="eq-cat">${esc(cat)}</div><datalist id="${lid}">${S.catalog.filter(c => c.Category === cat).map(c => `<option value="${esc(c.Model)}">`).join('')}</datalist>`;
        d.forEach((it, i) => {
          if (it.Category !== cat) return;
          html += `<div class="eq-row editing ${it._del ? 'removed' : ''}"><input class="model-in" data-i="${i}" data-k="Model" list="${lid}" value="${esc(it.Model)}" aria-label="Model" ${it._del ? 'disabled' : ''}>
            <input class="qty-in" data-i="${i}" data-k="Qty" type="number" min="0" value="${esc(it.Qty)}" placeholder="?" aria-label="Quantity" ${it._del ? 'disabled' : ''}>
            <button class="btn small ${it._del ? '' : 'danger'}" data-del="${i}">${it._del ? 'Undo' : 'Remove'}</button></div>`;
        });
        html += '</div>';
      });
      html += `<form class="inline-form" id="add-form" style="margin-top:12px">
        <label>Category<select id="add-cat">${allCats.map(c => `<option ${c === S.eqAddCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Model (pick or type a new one)<input id="add-model" list="dl-add"><datalist id="dl-add"></datalist></label>
        <label>Qty<input id="add-qty" type="number" min="0" value="1" style="min-width:0;width:70px"></label>
        <button class="btn small" type="submit">+ Add to list</button></form>`;
    } else {
      if (canEdit()) html = `<div class="edit-bar"><button class="btn primary small" id="eq-edit">✎ Edit equipment</button></div>` + html;
      const cats = Array.from(new Set(items.map(i => i.Category))).sort((a, b) => catRank(a) - catRank(b) || cmp(a, b));
      if (!items.length) html += '<div class="note">No equipment on file for this room.</div>';
      cats.forEach(cat => {
        html += `<div class="eq-group"><div class="eq-cat">${esc(cat)}</div>`;
        items.filter(it => it.Category === cat).forEach(it => {
          html += `<div class="eq-row"><span class="model">${esc(it.Model)}</span><span class="qty" ${it.Qty === '' || it.Qty == null ? 'title="Quantity not recorded"' : ''}>${qtyText(it.Qty)}</span></div>`;
        });
        html += '</div>';
      });
    }
    $('#pbody').innerHTML = html; wireProjectLinks($('#pbody'));
    $('#pfoot').innerHTML = S.eqEditAll ? `<div class="save-bar edit-foot"><span style="font-size:12.5px;font-weight:600">Editing equipment</span>
      <span style="display:flex;gap:8px"><button class="btn small" id="eq-cancel">Cancel</button><button class="btn primary small" id="eq-save">Save changes</button></span></div>` : '';
    if ($('#eq-edit')) $('#eq-edit').onclick = () => { S.eqEditAll = true; S.eqDraft = items.map(i => Object.assign({}, i)); renderPanel(); };
    if (!S.eqEditAll) return;
    $$('#pbody [data-k]').forEach(el => el.oninput = () => { S.eqDraft[+el.dataset.i][el.dataset.k] = el.value; });
    $$('#pbody [data-del]').forEach(b => b.onclick = () => { const it = S.eqDraft[+b.dataset.del]; it._del = !it._del; renderPanel(); });
    const fillAdd = () => { S.eqAddCat = $('#add-cat').value; $('#dl-add').innerHTML = S.catalog.filter(c => c.Category === $('#add-cat').value).map(c => `<option value="${esc(c.Model)}">`).join(''); };
    $('#add-cat').onchange = fillAdd; fillAdd();
    $('#add-form').onsubmit = e => { e.preventDefault(); const m = $('#add-model').value.trim(); if (!m) { toast('Enter a model', true); return; }
      S.eqDraft.push({ Category: $('#add-cat').value, Model: m, Qty: $('#add-qty').value }); renderPanel(); const n = $('#add-model'); if (n) n.focus(); };
    $('#eq-cancel').onclick = () => { S.eqEditAll = false; S.eqDraft = null; renderPanel(); };
    $('#eq-save').onclick = async () => {
      const keep = S.eqDraft.filter(i => !i._del);
      if (keep.some(i => !String(i.Model).trim())) { toast('Every item needs a model name (or remove it)', true); return; }
      S.eqEditAll = false; const draft = S.eqDraft; S.eqDraft = null;
      await saveItems(r, keep, 'Equipment saved');
      if (S.eqEditAll === false && $('#eq-save')) { S.eqEditAll = true; S.eqDraft = draft; }
    };
  }
  async function renderHistory(r) {
    $('#pbody').innerHTML = '<div class="loading">Loading history…</div>';
    try {
      const d = await api('history', { roomId: r.RoomID });
      if (S.open !== r.RoomID || S.tab !== 'history') return;
      $('#pbody').innerHTML = (canEdit() ? roomProjectHistoryHtml(r) : '') + (d.history.length ? d.history.map(h => `<div class="history-item"><span class="who">${esc(h.User)}</span><span class="when">${esc(h.Timestamp)}</span>
        <div class="what">${esc(h.Action)}${has(h.Field) ? ' · ' + esc(h.Field) : ''}${has(h['Old Value']) || has(h['New Value']) ? `: ${esc(h['Old Value'] || '—')} → ${esc(h['New Value'] || '—')}` : ''}</div></div>`).join('')
        : '<div class="note">No changes recorded for this room yet. Edits made on this site show up here with who made them and when.</div>');
      wireProjectLinks($('#pbody'));
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
    let html = `<div class="page-head"><div><h2>Equipment Catalog</h2><p>Click a category to open it, then a model to see which rooms have it.${canEdit() ? ' Edit renames a model everywhere it\'s used.' : ''}</p></div>
      <span style="display:flex;gap:8px;flex-wrap:wrap"><label class="switch"><input type="checkbox" id="show-unused" ${S.showUnused ? 'checked' : ''}><span class="track" aria-hidden="true"></span>Show unused models</label><button class="btn small" id="cat-all">Open all</button><button class="btn small" id="cat-none">Close all</button>${canEdit() ? '<button class="btn small" id="add-cat">+ Add category</button>' : ''}</span></div>
      <p class="cat-note">Room counts leave out archived rooms. A model is <b>unused</b> when no active room has it${S.role === 'Admin' ? '; only unused models can be deleted' : ''}.</p><div id="new-cat"></div>`;
    names.forEach(cat => {
      const all = cats[cat].slice().sort((a, b) => cmp(a.Model, b.Model)).map(it => { const u = roomsUsing(cat, it.Model); return Object.assign({}, it, { _act: u.filter(x => !isArchived(x.room)), _arch: u.filter(x => isArchived(x.room)) }); });
      const unusedN = all.filter(it => !it._act.length).length;
      const items = all.filter(it => S.showUnused || it._act.length || S.catEditing === cat + '||' + it.Model);
      const catOpen = S.catCatOpen.has(cat) || S.catAdding === cat || (S.catEditing || '').startsWith(cat + '||');
      html += `<details class="cat-section" data-cat="${esc(cat)}" ${catOpen ? 'open' : ''}><summary><h3>${esc(cat)} <small>${all.length - unusedN} in use${unusedN ? ` · ${unusedN} unused${S.showUnused ? '' : ' (hidden)'}` : ''}</small></h3></summary><div class="scroll"><table class="t">
        <thead><tr><th>Model</th><th style="width:70px">Rooms</th><th style="width:130px">Last price paid</th><th></th></tr></thead><tbody>`;
      items.forEach(it => {
        const k = cat + '||' + it.Model, using = it._act, archUsing = it._arch, open = S.catOpen.has(k);
        const price = has(it['Last Price Paid']) ? '$' + Number(it['Last Price Paid']).toLocaleString() : '—';
        if (S.catEditing === k) {
          html += `<tr><td><input id="ce-model" value="${esc(it.Model)}" aria-label="Model name"></td><td class="num">${using.length}</td>
            <td><input id="ce-price" inputmode="decimal" value="${esc(it['Last Price Paid'])}" aria-label="Last price paid"></td>
            <td class="act"><button class="btn primary small" data-save="${esc(k)}">Save</button> <button class="btn small" data-cancel>Cancel</button></td></tr>`;
        } else {
          const canDel = S.role === 'Admin' && !using.length;
          html += `<tr class="${using.length ? '' : 'unused'}"><td><button class="model-link" data-toggle="${esc(k)}" aria-expanded="${open}"><span class="caret">▶</span>${esc(it.Model)}</button>${using.length ? '' : '<span class="tag unused-tag">Unused</span>'}</td>
            <td class="num">${using.length}</td><td class="num">${price}</td><td class="act">${canEdit() ? `<button class="btn small" data-edit="${esc(k)}">Edit</button>` : ''}${canDel ? ` <button class="btn danger small" data-del="${esc(k)}">Delete</button>` : ''}</td></tr>`;
          if (S.catDeleting === k) html += `<tr class="where"><td colspan="4"><div class="warn-box"><b>Delete ${esc(it.Model)} from the catalog?</b> It will no longer be offered when adding equipment.${archUsing.length ? (archUsing.length === 1 ? ' The 1 archived room that lists it keeps its equipment record.' : ` The ${archUsing.length} archived rooms that list it keep their equipment records.`) : ''}
            <span style="display:flex;gap:8px;margin-top:8px"><button class="btn danger small" data-del-yes="${esc(k)}">Yes, delete model</button><button class="btn small" data-cancel>Cancel</button></span></div></td></tr>`;
        }
        const chip = u => `<button class="room-chip ${isArchived(u.room) ? 'arch' : ''}" data-room="${esc(u.room.RoomID)}">${esc(roomName(u.room))}${isArchived(u.room) ? ' (archived)' : ''}<span class="q">×${u.qty == null ? '?' : u.qty}</span></button>`;
        if (open) html += `<tr class="where"><td colspan="4">${using.length ? `<div class="chips">${using.map(chip).join('')}</div>` : '<span style="opacity:.6">No active rooms have this model.</span>'}${archUsing.length ? `<div class="chips" style="margin-top:6px">${archUsing.map(chip).join('')}</div>` : ''}</td></tr>`;
      });
      if (S.catAdding === cat) html += `<tr><td><input id="cn-model" placeholder="Model name" aria-label="New model name"></td><td class="num">0</td><td><input id="cn-price" inputmode="decimal" placeholder="0" aria-label="Last price paid"></td>
        <td class="act"><button class="btn primary small" data-create="${esc(cat)}">Add</button> <button class="btn small" data-cancel>Cancel</button></td></tr>`;
      if (!items.length && S.catAdding !== cat) html += `<tr><td colspan="4" style="opacity:.6">All ${all.length} model${all.length === 1 ? '' : 's'} here are unused. Turn on Show unused models to see ${all.length === 1 ? 'it' : 'them'}.</td></tr>`;
      html += `</tbody></table></div>${S.catAdding === cat || !canEdit() ? '' : `<button class="btn small" style="margin-top:8px" data-add="${esc(cat)}">+ Add model</button>`}</details>`;
    });
    const main = subHost(); main.innerHTML = html;
    $$('details.cat-section', main).forEach(d => d.addEventListener('toggle', () => { d.open ? S.catCatOpen.add(d.dataset.cat) : S.catCatOpen.delete(d.dataset.cat); }));
    $('#cat-all').onclick = () => { names.forEach(n => S.catCatOpen.add(n)); renderCatalog(); };
    $('#cat-none').onclick = () => { S.catCatOpen.clear(); renderCatalog(); };
    $('#show-unused').onchange = e => { S.showUnused = e.target.checked; renderCatalog(); };
    $$('[data-del]', main).forEach(b => b.onclick = () => { S.catDeleting = b.dataset.del; S.catEditing = null; S.catAdding = null; renderCatalog(); });
    $$('[data-del-yes]', main).forEach(b => b.onclick = async () => {
      const i = b.dataset.delYes.indexOf('||'), cat = b.dataset.delYes.slice(0, i), model = b.dataset.delYes.slice(i + 2);
      try { const d = await api('deleteCatalogItem', { category: cat, model }); S.catalog = d.catalog; S.catDeleting = null; S.catOpen.delete(b.dataset.delYes); toast('Model deleted'); renderCatalog(); }
      catch (e) { toast(e.message, true); }
    });
    $$('[data-toggle]', main).forEach(b => b.onclick = () => { const k = b.dataset.toggle; S.catOpen.has(k) ? S.catOpen.delete(k) : S.catOpen.add(k); renderCatalog(); });
    $$('[data-edit]', main).forEach(b => b.onclick = () => { S.catEditing = b.dataset.edit; S.catAdding = null; renderCatalog(); $('#ce-model').focus(); });
    $$('[data-cancel]', main).forEach(b => b.onclick = () => { S.catEditing = null; S.catAdding = null; S.catDeleting = null; renderCatalog(); });
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
    if ($('#add-cat')) $('#add-cat').onclick = () => {
      $('#new-cat').innerHTML = `<form class="inline-form" id="nc"><label>New category name<input id="nc-name" placeholder="e.g. Wireless Presentation Hub" required></label>
        <button class="btn primary small" type="submit">Create category</button><button class="btn small" type="button" id="nc-x">Cancel</button></form>`;
      $('#nc-x').onclick = () => { $('#new-cat').innerHTML = ''; };
      $('#nc').onsubmit = e => { e.preventDefault(); const n = $('#nc-name').value.trim(); if (!n) return; S.extraCats = (S.extraCats || []).concat(n); S.catAdding = n; S.catCatOpen.add(n); renderCatalog(); $('#cn-model').focus(); };
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
    subHost().innerHTML = `<div class="page-head"><div><h2>Reports</h2><p>Click a report to open or close it.</p></div></div>` +
      sec('eq', 'Which rooms have this equipment?', `<div class="controls">
          <select class="dd" id="rp-cat" aria-label="Category">${cats.map(c => `<option ${c === S.rp.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <select class="dd" id="rp-model" aria-label="Model"></select>
          <select class="dd" id="rp-ctl" aria-label="Room type"><option value="all">All rooms</option><option value="ctl">CTL-supported rooms</option><option value="non">Non-CTL rooms</option></select>
        </div><div id="rp-out"></div>`, 'eq') +
      sec('lc', 'Lifecycle refresh candidates', `<p style="font-size:12.5px;opacity:.75;margin:0 0 10px">Left off this list: rooms with an open project past consultation (see Projects) or a planned update year, and rooms marked Won't be updated (see the next report).</p>
        <div class="controls"><label style="font-size:12.5px;display:flex;gap:8px;align-items:center">Equipment info older than
          <input id="rp-year" type="number" value="${new Date().getFullYear() - STALE}" style="width:84px;padding:6px 8px;border:1px solid var(--line-strong);border-radius:3px;background:var(--card)"></label></div>
        <div id="rp-life"></div>`, 'lc') +
      sec('nu', "Won't be updated", `<p style="font-size:12.5px;opacity:.75;margin:0 0 10px">Rooms whose Refresh Plan is set to Won't be updated. To put one back on the refresh list, open it and clear Refresh Plan.</p><div id="rp-nu"></div>`, 'nu');
    $$('.rp-sec').forEach(d => d.addEventListener('toggle', () => { S.rpOpen[d.dataset.sec] = d.open; }));
    $('#rp-ctl').value = S.rp.ctl;
    const eqRows = () => {
      const byId = {}; S.rooms.forEach(r => byId[r.RoomID] = r);
      const rows = [];
      S.equipment.forEach(e => {
        if (e.Category !== S.rp.cat || (S.rp.model && e.Model !== S.rp.model)) return;
        const r = byId[e.RoomID]; if (!r || isArchived(r)) return;
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
      $('#cnt-eq').textContent = `${S.rp.cat}${S.rp.model ? ' · ' + S.rp.model : ''} · ${rooms} room${rooms === 1 ? '' : 's'}`;
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
      return S.rooms.filter(r => !isArchived(r) && !wontUpdate(r) && r['Record Type'] !== 'Contact Info Only' && !plannedYear(r) && !committedProject(r) && asOfYear(r['Equipment Info As Of']) && asOfYear(r['Equipment Info As Of']) < y)
        .sort((a, b) => String(a['Equipment Info As Of']).localeCompare(String(b['Equipment Info As Of'])))
        .map(r => { const row = [r.Building, r.Room, r.Zone || '', isCTL(r) ? 'CTL' : 'Non-CTL', r['Equipment Info As Of'], r['Latest Update'] || '']; row._id = r.RoomID; return row; });
    };
    const life = () => {
      const rows = lcRows();
      $('#cnt-lc').textContent = rows.length + (rows.length === 1 ? ' room' : ' rooms');
      $('#rp-life').innerHTML = `<p style="font-size:12.5px;margin:0 0 10px">${rows.length} rooms, oldest first. Archived rooms are left out.</p>` + (rows.length ? tableHtml(LCH, rows) : '');
      $$('#rp-life [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    };
    $('#lc-csv').onclick = () => exportCSV('Lifecycle refresh candidates', LCH, lcRows());
    $('#lc-xlsx').onclick = () => exportXLSX('Lifecycle refresh candidates', [{ name: 'Lifecycle', headers: LCH, rows: lcRows() }]);
    const NUH = ['Building', 'Room', 'Zone', 'CTL', 'Equipment Info As Of', 'Notes'];
    const nuRows = () => S.rooms.filter(r => !isArchived(r) && wontUpdate(r)).sort((a, b) => cmp(a.Building, b.Building) || cmp(a.Room, b.Room))
      .map(r => { const row = [r.Building, r.Room, r.Zone || '', isCTL(r) ? 'CTL' : 'Non-CTL', r['Equipment Info As Of'] || '', r.Notes || '']; row._id = r.RoomID; return row; });
    const nr = nuRows();
    $('#cnt-nu').textContent = nr.length + (nr.length === 1 ? ' room' : ' rooms');
    $('#rp-nu').innerHTML = nr.length ? tableHtml(NUH, nr) : '<div class="note">No rooms are marked Won\'t be updated.</div>';
    $$('#rp-nu [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    $('#nu-csv').onclick = () => exportCSV("Rooms that won't be updated", NUH, nuRows());
    $('#nu-xlsx').onclick = () => exportXLSX("Rooms that won't be updated", [{ name: "Won't be updated", headers: NUH, rows: nuRows() }]);
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
    const ctlIn = z => S.rooms.filter(r => isCTL(r) && !isArchived(r) && String(r.Zone || '').trim().toLowerCase() === String(z).trim().toLowerCase()).sort((a, b) => cmp(a.Building, b.Building) || cmp(a.Room, b.Room));
    const noZone = S.rooms.filter(r => !has(r.Zone)).length;
    const totalRooms = zones.reduce((n, z) => n + ctlIn(z.Zone).length, 0), totalSeats = zones.reduce((n, z) => n + ctlIn(z.Zone).reduce((s, r) => s + seats(r), 0), 0);
    let html = `<div class="page-head"><div><h2>Zones</h2><p>Each room's CTL contact comes from its zone. Change a technician here and every room in that zone, CTL or non-CTL, shows the new person. The backup zone's technician is listed as who to call if the first person is unavailable.</p></div>
      <span style="display:flex;gap:8px;flex-wrap:wrap">${exportButtons('zn')}${canEdit() ? '<button class="btn primary small" id="zn-add">+ Add zone</button>' : ''}</span></div>
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
          ${canEdit() ? `<button class="btn small" data-zedit="${esc(z.Zone)}">Edit</button>` : ''}</div>
          <details><summary style="cursor:pointer;font-size:12.5px">Show ${rooms.length} CTL rooms</summary><div style="margin-top:10px">${
            rooms.length ? tableHtml(['Building', 'Room', 'Room Type', 'Seats'], rooms.map(r => { const row = [r.Building, r.Room, r['Room Type'] || '', seats(r) || '']; row._id = r.RoomID; return row; }), [3]) : '<div class="note">No CTL-supported rooms in this zone.</div>'}</div></details>`;
      }
      html += `</section>`;
    });
    subHost().innerHTML = html;
    $$('[data-zedit]').forEach(x => x.onclick = () => { S.zoneEditing = x.dataset.zedit; renderZones(); });
    $$('#main [data-room]').forEach(x => x.onclick = () => openRoom(S.rooms.find(r => r.RoomID === x.dataset.room)));
    if ($('#zn-add')) $('#zn-add').onclick = () => { S.zoneEditing = '__new'; renderZones(); };
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

  // ------------------------------------------------------------------ projects
  // A project moves through PHASES; Cancelled sits off the board. Projects link to rooms by RoomID.
  const PHASES = ['Consultation', 'Funding Requested', 'Funded', 'Equipment Ordered', 'Equipment Received', 'Active', 'Completed'];
  const OPEN_PHASES = PHASES.slice(0, 6);
  const COMMITTED = ['Funding Requested', 'Funded', 'Equipment Ordered', 'Equipment Received', 'Active']; // counts as a planned upgrade
  const PROJECT_TYPES = ['Complete Upgrade', 'Partial Upgrade', 'New Install', 'Uninstall & Reinstall', 'Repair / Replacement', 'Consultation', 'Decommission', 'Other'];
  const FUNDING = ['STF', 'Client Funded', 'Other'];
  const TDX = CFG.TDX_TICKET_URL || 'https://uga.teamdynamix.com/TDNext/Apps/499/Tickets/TicketDet.aspx?TicketID=';
  const PJ_FIELDS = ['Title', 'Ticket ID', 'Project Type', 'Funding Source', 'STF Year', 'Amount', 'Proposed Install', 'Department', 'Notes'];

  const projRooms = p => String(p.Rooms || '').split(/[,;\s]+/).filter(Boolean);
  const projectsFor = id => S.projects.filter(p => projRooms(p).includes(id));
  const isOpenProject = p => OPEN_PHASES.includes(p.Phase);
  function committedProject(r) {
    const list = projectsFor(r.RoomID).filter(p => COMMITTED.includes(p.Phase));
    return list.sort((a, b) => PHASES.indexOf(b.Phase) - PHASES.indexOf(a.Phase))[0] || null;
  }
  const ticketLink = p => has(p['Ticket ID']) ? `<a class="tdx" href="${esc(TDX + encodeURIComponent(p['Ticket ID']))}" target="_blank" rel="noopener">#${esc(p['Ticket ID'])} ↗</a>` : '';
  const money = v => has(v) && !isNaN(+v) ? '$' + Number(v).toLocaleString() : '';
  const roomLabelById = id => { const r = S.rooms.find(x => x.RoomID === id); return r ? roomName(r) : id; };
  // STF / fiscal year runs July 1 – June 30 and is named for the year it ends in: 2026-07-01 → FY27.
  function fyOf(date) { const m = /^(\d{4})-(\d{2})/.exec(String(date || '')); if (!m) return null; return (+m[2] >= 7 ? +m[1] + 1 : +m[1]); }
  const fyLabel = y => `STF${String(y).slice(-2)} (Jul 1, ${y - 1} – Jun 30, ${y})`;
  const phaseDate = (p, ph) => String(p[ph + ' On'] || '').slice(0, 10);
  const lastPhaseDate = p => phaseDate(p, p.Phase);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); if (!m) return ''; return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + (+m[1] === new Date().getFullYear() ? '' : ', ' + m[1]); }

  function stepper(p, clickable) {
    const cur = PHASES.indexOf(p.Phase);
    return `<div class="stepper ${p.Phase === 'Cancelled' ? 'cancelled' : ''}">${PHASES.map((ph, i) => {
      const st = p.Phase === 'Cancelled' ? '' : i < cur ? 'done' : i === cur ? 'current' : '';
      const d = phaseDate(p, ph);
      return `<button class="step ${st}" ${clickable ? `data-phase="${esc(ph)}"` : 'disabled'} title="${esc(ph)}${d ? ' · ' + d : ''}"><span>${esc(ph)}</span>${d ? `<small>${esc(d)}</small>` : ''}</button>`;
    }).join('')}</div>`;
  }

  // Room panel: projects linked to this room
  function roomProjectsHtml(r) {
    if (!canEdit()) return '';
    const list = projectsFor(r.RoomID);
    const open = list.filter(isOpenProject);
    let html = `<div class="section-title">Projects</div>`;
    html += open.length ? open.map(p => `<div class="contact pj-mini"><div class="role">${esc(p.Phase)}${lastPhaseDate(p) ? ' since ' + esc(lastPhaseDate(p)) : ''}</div>
        <button class="model-link" data-project="${esc(p.ProjectID)}">${esc(p.Title)}</button>
        <div class="line">${[p['Funding Source'], p['STF Year'], money(p.Amount)].filter(has).map(esc).join(' · ')} ${ticketLink(p)}</div></div>`).join('')
      : '<div class="note">No open project for this room.</div>';
    const done = list.filter(p => p.Phase === 'Completed').length;
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px"><button class="btn small" data-newproject="${esc(r.RoomID)}">+ New project for this room</button>
      ${done ? `<button class="btn small" data-tabjump="history">${done} completed project${done === 1 ? '' : 's'} in History</button>` : ''}</div>`;
    return html;
  }
  function roomProjectHistoryHtml(r) {
    const list = projectsFor(r.RoomID).sort((a, b) => cmp(lastPhaseDate(b) || b.Created, lastPhaseDate(a) || a.Created));
    if (!list.length) return '';
    return `<div class="section-title">Projects</div><div class="scroll" style="margin-bottom:16px"><table class="t"><thead><tr><th>Project</th><th>Phase</th><th>Date</th><th>Ticket</th></tr></thead><tbody>${list.map(p =>
      `<tr><td><button class="model-link" data-project="${esc(p.ProjectID)}">${esc(p.Title)}</button></td><td>${esc(p.Phase)}</td><td>${esc(lastPhaseDate(p))}</td><td>${ticketLink(p)}</td></tr>`).join('')}</tbody></table></div>
      <div class="section-title">Changes</div>`;
  }
  function wireProjectLinks(root) {
    $$('[data-project]', root).forEach(b => b.onclick = () => openProject(b.dataset.project));
    $$('[data-newproject]', root).forEach(b => b.onclick = () => newProject([b.dataset.newproject]));
    $$('[data-tabjump]', root).forEach(b => b.onclick = () => { S.tab = b.dataset.tabjump; renderPanel(); });
  }

  // ---- Projects page
  function renderProjects() {
    const v = S.pj.view;
    const head = `<div class="page-head"><div><h2>Projects</h2><p>Room upgrade projects from first consultation to completion. Click a project to see or change it.</p></div>
      <span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary small" id="pj-new">+ New project</button></span></div>
      <div class="seg" role="tablist">${[['board', 'Board'], ['list', 'List'], ['completed', 'Completed']].map(([k, l]) =>
        `<button class="seg-btn ${v === k ? 'active' : ''}" data-pjview="${k}">${l}</button>`).join('')}</div>`;
    $('#main').innerHTML = head + '<div id="pj-body"></div>';
    $$('[data-pjview]').forEach(b => b.onclick = () => { const was = S.pj.view; S.pj.view = b.dataset.pjview; if (was === 'completed' || S.pj.view === 'completed') S.pj.q = ''; renderProjects(); });
    $('#pj-new').onclick = () => newProject([]);
    if (v === 'completed') renderCompleted(); else if (v === 'list') renderProjectList(); else renderBoard();
  }
  function pjMatches(p, q) {
    if (!q) return true;
    const hay = [p.Title, p['Ticket ID'], p['STF Year'], p['Funding Source'], p.Notes, p.Department].concat(projRooms(p).map(roomLabelById)).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
  }
  function renderBoard() {
    const list = S.projects.filter(p => isOpenProject(p) && pjMatches(p, S.pj.q) && (!S.pj.fy || p['STF Year'] === S.pj.fy) && (!S.pj.fund || p['Funding Source'] === S.pj.fund));
    // compact card: just the project name; the rest shows on hover and when opened
    const card = p => `<button class="pj-card compact ${PHASE_CLASS(p.Phase)}" draggable="true" data-project="${esc(p.ProjectID)}"
        title="${esc([projRooms(p).length + ' room' + (projRooms(p).length === 1 ? '' : 's'), [p['Funding Source'], p['STF Year'], money(p.Amount)].filter(has).join(' · '), has(p['Ticket ID']) ? 'Ticket #' + p['Ticket ID'] : 'No ticket'].filter(has).join('\n'))}"><span class="pj-title">${esc(p.Title)}</span></button>`;
    $('#pj-body').innerHTML = projectFilters() + `
      <div class="board-scroll"><div class="board">
        ${OPEN_PHASES.map(ph => { const col = list.filter(p => p.Phase === ph).sort((a, b) => cmp(a.Title, b.Title));
          return `<section class="col" data-drop="${esc(ph)}"><h3 class="col-head" title="${ph === 'Equipment Received' ? 'Equipment is here, waiting to install' : esc(ph)}"><i class="dot ${PHASE_CLASS(ph)}"></i><span>${esc(ph)}</span><small class="pill">${col.length}</small></h3><div class="col-body">${col.map(card).join('') || '<div class="col-empty">None</div>'}</div></section>`; }).join('')}
        <section class="col col-done" data-drop="Completed"><h3 class="col-head"><i class="dot ph-completed"></i><span>Completed</span><small class="pill">${S.projects.filter(p => p.Phase === 'Completed' && fyOf(phaseDate(p, 'Completed')) === fyOf(new Date().toISOString().slice(0, 10))).length} in STF${String(fyOf(new Date().toISOString().slice(0, 10))).slice(-2)}</small></h3>
          <div class="col-body"><div class="col-empty">Drop a project here to mark it completed.</div><button class="btn small" id="pj-see-done">See completed</button></div></section>
      </div></div>
      <p class="cat-note" style="margin-top:10px">Drag a card to another column to change its phase, or click it to open it. Drop on Completed to finish it. Completed and cancelled projects are under Completed.</p>`;
    wireProjectFilters(renderBoard);
    $('#pj-see-done').onclick = () => { S.pj.view = 'completed'; S.pj.q = ''; renderProjects(); };
    wireProjectLinks($('#pj-body'));
    // drag and drop between columns (mouse; on touch screens open the card and click a phase instead)
    let dragId = null;
    $$('.pj-card[draggable]').forEach(c => {
      c.addEventListener('dragstart', e => { dragId = c.dataset.project; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch (x) {} });
      c.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.col.drop-over').forEach(x => x.classList.remove('drop-over')); });
    });
    $$('.col[data-drop]').forEach(col => {
      col.addEventListener('dragover', e => { if (!dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drop-over'); });
      col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop-over'); });
      col.addEventListener('drop', e => { e.preventDefault(); col.classList.remove('drop-over'); const id = dragId; dragId = null; if (id) moveProject(id, col.dataset.drop); });
    });
  }
  async function moveProject(id, phase) {
    const p = S.projects.find(x => x.ProjectID === id);
    if (!p || p.Phase === phase) return;
    if (phase === 'Completed') { openProject(id); S.pj.confirm = 'Completed'; renderProjectPanel(); return; }   // asks for the completion date
    const old = p.Phase;
    p.Phase = phase; renderBoard();                                                   // move it right away, undo if the save fails
    try { const d = await api('saveProject', { project: Object.assign({}, p, { Phase: phase }) }); S.projects = d.projects; toast(`Moved to ${phase}`); }
    catch (e) { p.Phase = old; toast(e.message, true); }
    if (S.page === 'projects' && S.pj.view === 'board') renderBoard();
  }
  function pjTable(headers, rows, list) {
    return `<div class="scroll"><table class="t"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr>${r.map((v, c) =>
      `<td class="${headers[c] === 'Amount' ? 'num' : ''}">${headers[c] === 'Project' ? `<button class="model-link" data-project="${esc(list[i].ProjectID)}">${esc(v)}</button>`
        : headers[c] === 'Ticket' ? ticketLink(list[i]) : headers[c] === 'Amount' ? esc(money(v)) : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function renderCompleted() {
    const curFY = fyOf(new Date().toISOString().slice(0, 10));
    const done = S.projects.filter(p => p.Phase === 'Completed');
    const dated = done.filter(p => phaseDate(p, 'Completed'));
    const undated = done.filter(p => !phaseDate(p, 'Completed'));
    const cancelled = S.projects.filter(p => p.Phase === 'Cancelled');
    const oldest = dated.reduce((m, p) => Math.min(m, fyOf(phaseDate(p, 'Completed'))), curFY);
    const years = []; for (let y = curFY; y >= oldest; y--) years.push(y);
    const sel = S.pj.year || curFY;
    const q = (S.pj.q || '').trim();
    let list, title, dateField = 'Completed';
    if (q) { list = done.concat(cancelled).filter(p => pjMatches(p, q)); title = `Search results in all years`; }
    else if (sel === 'undated') { list = undated; title = 'Completed, no completion date'; }
    else if (sel === 'cancelled') { list = cancelled; title = 'Cancelled projects'; dateField = 'Cancelled'; }
    else { list = dated.filter(p => fyOf(phaseDate(p, 'Completed')) === +sel); title = fyLabel(+sel); }
    const dateOf = p => phaseDate(p, p.Phase === 'Cancelled' ? 'Cancelled' : 'Completed');
    list = list.slice().sort((a, b) => cmp(dateOf(b) || '0', dateOf(a) || '0') || cmp(a.Title, b.Title));   // newest first
    const H = [q ? 'Date' : dateField + ' On', 'Project', 'Rooms', 'Type', 'Funding', 'STF Year', 'Amount', 'Ticket'].concat(q ? ['Phase'] : []);
    const rows = list.map(p => [dateOf(p), p.Title, projRooms(p).map(roomLabelById).join('; '), p['Project Type'] || '', p['Funding Source'] || '', p['STF Year'] || '',
      has(p.Amount) && !isNaN(+p.Amount) ? +p.Amount : '', p['Ticket ID'] || ''].concat(q ? [p.Phase] : []));
    const nRooms = new Set(list.flatMap(projRooms)).size;
    const total = list.reduce((t, p) => t + (has(p.Amount) && !isNaN(+p.Amount) ? +p.Amount : 0), 0);
    const stf = list.filter(p => p['Funding Source'] === 'STF' || /^FY\d{2}$/.test(p['STF Year'] || '')).length;
    const counts = {}; dated.forEach(p => { const y = fyOf(phaseDate(p, 'Completed')); counts[y] = (counts[y] || 0) + 1; });
    $('#pj-body').innerHTML = `<div class="controls" style="margin-top:12px">
        <select class="dd" id="pj-year" aria-label="STF year" ${q ? 'disabled' : ''}>${years.map(y => `<option value="${y}" ${String(y) === String(sel) ? 'selected' : ''}>${esc(fyLabel(y))}${y === curFY ? ' · current' : ''} — ${counts[y] || 0}</option>`).join('')}
          ${undated.length ? `<option value="undated" ${sel === 'undated' ? 'selected' : ''}>Completed, no date — ${undated.length}</option>` : ''}
          ${cancelled.length ? `<option value="cancelled" ${sel === 'cancelled' ? 'selected' : ''}>Cancelled — ${cancelled.length}</option>` : ''}</select>
        <input class="search" id="pj-q" type="search" placeholder="Search all years: title, room, ticket…" value="${esc(S.pj.q)}" style="flex:1 1 240px">
        ${exportButtons('pjc')}</div>
      <h3 class="pj-year-title">${esc(title)}</h3>
      <div class="tiles" style="margin:6px 0 14px"><div><div class="num">${list.length}</div><div class="lbl">project${list.length === 1 ? '' : 's'}</div></div>
        <div><div class="num">${nRooms}</div><div class="lbl">rooms</div></div><div><div class="num">${stf}</div><div class="lbl">STF funded</div></div>
        <div><div class="num">${money(total) || '$0'}</div><div class="lbl">recorded amount</div></div></div>
      ${rows.length ? pjTable(H, rows, list) : `<div class="note">${q ? 'No completed or cancelled projects match.' : 'No projects completed in this STF year yet.'}</div>`}`;
    $('#pj-year').onchange = e => { S.pj.year = /^\d+$/.test(e.target.value) ? +e.target.value : e.target.value; renderCompleted(); };
    const qi = $('#pj-q');
    qi.oninput = () => { S.pj.q = qi.value; clearTimeout(renderCompleted.t); renderCompleted.t = setTimeout(() => { renderCompleted(); const n = $('#pj-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
    const name = () => q ? 'Projects search' : sel === 'cancelled' ? 'Cancelled projects' : sel === 'undated' ? 'Completed projects (no date)' : 'Completed projects STF' + String(sel).slice(-2);
    $('#pjc-csv').onclick = () => exportCSV(name(), H, rows);
    $('#pjc-xlsx').onclick = () => exportXLSX(name(), [{ name: 'Projects', headers: H, rows }]);
    wireProjectLinks($('#pj-body'));
  }

  // ---- Projects: list view (open projects as a sortable table)
  const PHASE_CLASS = ph => 'ph-' + String(ph).toLowerCase().replace(/[^a-z]+/g, '-');
  const phaseChip = ph => `<span class="phase-chip ${PHASE_CLASS(ph)}">${esc(ph)}</span>`;
  const daysSince = d => { if (!d) return null; const t = Date.parse(String(d).slice(0, 10)); return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000); };
  const LIST_SORTS = [
    ['phase', 'Phase (pipeline order)'], ['recent', 'Most recently moved'], ['stuck', 'Longest in current phase'],
    ['title', 'Project name (A–Z)'], ['room', 'Building and room'], ['stf', 'STF year'], ['amount', 'Amount (highest first)'], ['ticket', 'Ticket number'],
  ];
  function sortProjects(list, key, dir) {
    const firstRoom = p => projRooms(p).map(roomLabelById)[0] || '~';
    const num = v => has(v) && !isNaN(+v) ? +v : -Infinity;
    const cmpBy = {
      phase: (a, b) => PHASES.indexOf(a.Phase) - PHASES.indexOf(b.Phase) || cmp(a.Title, b.Title),
      recent: (a, b) => cmp(lastPhaseDate(b) || '0', lastPhaseDate(a) || '0'),
      stuck: (a, b) => cmp(lastPhaseDate(a) || '9', lastPhaseDate(b) || '9'),
      title: (a, b) => cmp(a.Title, b.Title),
      room: (a, b) => cmp(firstRoom(a), firstRoom(b)),
      stf: (a, b) => cmp(a['STF Year'] || '~', b['STF Year'] || '~') || cmp(a.Title, b.Title),
      amount: (a, b) => num(b.Amount) - num(a.Amount),
      ticket: (a, b) => cmp(a['Ticket ID'] || '~', b['Ticket ID'] || '~'),
    }[key] || ((a, b) => 0);
    const out = list.slice().sort(cmpBy);
    return dir === 'desc' ? out.reverse() : out;
  }
  function projectFilters(extra) {
    const years = Array.from(new Set(S.projects.filter(isOpenProject).map(p => p['STF Year']).filter(has))).sort(cmp);
    return `<div class="controls" style="margin-top:14px">
        <input class="search" id="pj-q" type="search" placeholder="Search title, room, ticket…" value="${esc(S.pj.q)}" style="flex:1 1 240px">
        <select class="dd" id="pj-fy" aria-label="STF year"><option value="">All STF years</option>${years.map(y => `<option ${y === S.pj.fy ? 'selected' : ''}>${esc(y)}</option>`).join('')}</select>
        <select class="dd" id="pj-fund" aria-label="Funding"><option value="">All funding</option>${FUNDING.map(f => `<option ${f === S.pj.fund ? 'selected' : ''}>${f}</option>`).join('')}</select>
        ${extra || ''}</div>`;
  }
  function wireProjectFilters(rerender) {
    const q = $('#pj-q');
    q.oninput = () => { S.pj.q = q.value; clearTimeout(rerender.t); rerender.t = setTimeout(() => { rerender(); const n = $('#pj-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 220); };
    $('#pj-fy').onchange = e => { S.pj.fy = e.target.value; rerender(); };
    $('#pj-fund').onchange = e => { S.pj.fund = e.target.value; rerender(); };
  }
  function renderProjectList() {
    const sort = S.pj.sort || 'phase', dir = S.pj.dir || 'asc';
    const list = sortProjects(S.projects.filter(p => isOpenProject(p) && pjMatches(p, S.pj.q) && (!S.pj.fy || p['STF Year'] === S.pj.fy)
      && (!S.pj.fund || p['Funding Source'] === S.pj.fund) && (!S.pj.phase || p.Phase === S.pj.phase)), sort, dir);
    const cols = [['phase', 'Phase'], ['title', 'Project'], ['room', 'Rooms'], [null, 'Funding'], ['stf', 'STF year'], ['amount', 'Amount'], ['ticket', 'Ticket'], ['recent', 'In phase']];
    const arrow = k => k === sort ? `<span class="sort-arrow" aria-hidden="true">${dir === 'asc' ? '▲' : '▼'}</span>` : '';
    const rows = list.map(p => { const d = daysSince(lastPhaseDate(p)); const rooms = projRooms(p).map(roomLabelById);
      return `<tr><td>${phaseChip(p.Phase)}</td><td><button class="model-link pj-name" data-project="${esc(p.ProjectID)}">${esc(p.Title)}</button></td>
        <td>${rooms.length ? esc(rooms.slice(0, 2).join(', ')) + (rooms.length > 2 ? ` <span class="muted">+${rooms.length - 2}</span>` : '') : '<span class="muted">None linked</span>'}</td>
        <td>${esc(p['Funding Source'] || '')}</td><td>${esc(p['STF Year'] || '')}</td><td class="num">${esc(money(p.Amount))}</td><td>${ticketLink(p)}</td>
        <td class="num ${d != null && d > 90 ? 'stale-days' : ''}" title="${esc(lastPhaseDate(p) ? 'Since ' + lastPhaseDate(p) : 'No date recorded')}">${d == null ? '—' : d === 0 ? 'Today' : d + ' day' + (d === 1 ? '' : 's')}</td></tr>`; }).join('');
    $('#pj-body').innerHTML = projectFilters(`
        <select class="dd" id="pj-phase" aria-label="Phase"><option value="">All open phases</option>${OPEN_PHASES.map(ph => `<option ${ph === S.pj.phase ? 'selected' : ''}>${ph}</option>`).join('')}</select>
        <label class="sort-ctl">Sort by <select class="dd" id="pj-sort">${LIST_SORTS.map(([k, l]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn small" id="pj-dir" title="Reverse order">${dir === 'asc' ? '↑ Ascending' : '↓ Descending'}</button>
        <span class="count">${list.length} open project${list.length === 1 ? '' : 's'}</span>`) +
      (list.length ? `<div class="scroll card-table"><table class="t pj-list"><thead><tr>${cols.map(([k, l]) => k ? `<th><button class="th-sort ${k === sort ? 'on' : ''}" data-sort="${k}">${l}${arrow(k)}</button></th>` : `<th>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="note">No open projects match.</div>');
    wireProjectFilters(renderProjectList);
    $('#pj-phase').onchange = e => { S.pj.phase = e.target.value; renderProjectList(); };
    $('#pj-sort').onchange = e => { S.pj.sort = e.target.value; S.pj.dir = 'asc'; renderProjectList(); };
    $('#pj-dir').onclick = () => { S.pj.dir = dir === 'asc' ? 'desc' : 'asc'; renderProjectList(); };
    $$('[data-sort]').forEach(b => b.onclick = () => { const k = b.dataset.sort; if (k === sort) S.pj.dir = dir === 'asc' ? 'desc' : 'asc'; else { S.pj.sort = k; S.pj.dir = 'asc'; } renderProjectList(); });
    wireProjectLinks($('#pj-body'));
  }

  // ------------------------------------------------------------------ overview (staff home)
  function refreshCandidates() {
    const y = new Date().getFullYear() - STALE;
    return S.rooms.filter(r => !isArchived(r) && !wontUpdate(r) && r['Record Type'] !== 'Contact Info Only' && !plannedYear(r) && !committedProject(r)
      && asOfYear(r['Equipment Info As Of']) && asOfYear(r['Equipment Info As Of']) < y);
  }
  function wireTips(root) {
    const tip = $('#tip');
    $$('[data-tip]', root).forEach(el => {
      const show = e => { tip.innerHTML = el.dataset.tip; tip.hidden = false; const r = el.getBoundingClientRect(); const w = tip.offsetWidth;
        tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'; tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 8) + 'px'; };
      el.addEventListener('mouseenter', show); el.addEventListener('focus', show);
      el.addEventListener('mouseleave', () => { tip.hidden = true; }); el.addEventListener('blur', () => { tip.hidden = true; });
    });
  }
  function renderOverview() {
    const today = new Date().toISOString().slice(0, 10), fy = fyOf(today), yy = String(fy).slice(-2);
    const open = S.projects.filter(isOpenProject);
    const committed = open.filter(p => COMMITTED.includes(p.Phase));
    const doneThis = S.projects.filter(p => p.Phase === 'Completed' && fyOf(phaseDate(p, 'Completed')) === fy);
    // same point last year: completed between July 1 of last FY and this date one year ago
    const lastYearCut = (+today.slice(0, 4) - 1) + today.slice(4);
    const doneLastSoFar = S.projects.filter(p => p.Phase === 'Completed' && fyOf(phaseDate(p, 'Completed')) === fy - 1 && phaseDate(p, 'Completed') <= lastYearCut).length;
    const delta = doneThis.length - doneLastSoFar;
    const due = refreshCandidates();
    const live = S.rooms.filter(r => !isArchived(r));
    const ctl = live.filter(isCTL);
    // STF year progress: planned = completed this FY + open projects tagged with this FY
    const plannedFY = open.filter(p => p['STF Year'] === 'FY' + yy);
    const goal = doneThis.length + plannedFY.length;
    const pct = goal ? Math.round(doneThis.length / goal * 100) : 0;
    const committedAmt = plannedFY.concat(doneThis).reduce((t, p) => t + (has(p.Amount) && !isNaN(+p.Amount) ? +p.Amount : 0), 0);
    // charts
    const byPhase = OPEN_PHASES.map(ph => [ph, open.filter(p => p.Phase === ph).length]);
    const maxPh = Math.max(1, ...byPhase.map(x => x[1]));
    const byFY = Array.from(new Set(open.map(p => p['STF Year'] || ''))).sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || cmp(a, b))
      .map(y => { const l = open.filter(p => (p['STF Year'] || '') === y); return [y, l.length, l.reduce((t, p) => t + (has(p.Amount) && !isNaN(+p.Amount) ? +p.Amount : 0), 0)]; });
    const years = []; for (let y = fy - 7; y <= fy; y++) years.push([y, S.projects.filter(p => p.Phase === 'Completed' && fyOf(phaseDate(p, 'Completed')) === y).length]);
    const maxY = Math.max(1, ...years.map(x => x[1]));
    const niceMax = Math.ceil(maxY / 10) * 10 || 10;
    const H = 150;
    // needs attention
    const noRoom = open.filter(p => !projRooms(p).length);
    const noTicket = open.filter(p => p.Phase !== 'Consultation' && !has(p['Ticket ID']));
    const stuck = open.filter(p => { const d = daysSince(lastPhaseDate(p)); return d != null && d > 90; }).sort((a, b) => cmp(lastPhaseDate(a), lastPhaseDate(b)));
    const recent = open.concat(S.projects.filter(p => p.Phase === 'Completed')).filter(p => lastPhaseDate(p)).sort((a, b) => cmp(lastPhaseDate(b), lastPhaseDate(a))).slice(0, 6);
    const tile = (num, label, sub, go) => `<button class="ov-tile" ${go ? `data-go="${go}"` : 'disabled'}><span class="ov-label">${label}</span><span class="ov-num">${num}</span>${sub ? `<span class="ov-sub">${sub}</span>` : ''}</button>`;
    $('#main').innerHTML = `<div class="page-head"><div><h2>Overview</h2><p>${esc(fyLabel(fy))}. Click any number to see the list behind it.</p></div>
        <span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary small" id="ov-new">+ New project</button></span></div>
      <div class="ov-tiles">
        ${tile(open.length, 'Open projects', `${committed.length} funding requested or later`, 'board')}
        ${tile(doneThis.length, `Completed in STF${yy}`, delta === 0 ? 'Same as this point last year' : `<span class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}</span> vs this point last year`, 'completed')}
        ${tile(due.length, 'Rooms due for refresh', `Equipment info older than ${new Date().getFullYear() - STALE}`, 'refresh')}
        ${tile(ctl.length, 'CTL-supported rooms', `${live.length} rooms in the directory`, 'rooms')}
      </div>
      <div class="ov-grid">
        <div class="ov-col">
        <section class="ov-card">
          <div class="ov-card-head"><h3>Open projects by phase</h3><button class="link-more" data-go="board">Open board →</button></div>
          <div class="hbars">${byPhase.map(([ph, n]) => `<button class="hbar-row" data-go="phase:${esc(ph)}" data-tip="<b>${esc(ph)}</b><br>${n} project${n === 1 ? '' : 's'}">
            <span class="hbar-label"><i class="dot ${PHASE_CLASS(ph)}"></i>${esc(ph)}</span><span class="hbar-track"><span class="hbar" style="width:${n ? Math.max(2, n / maxPh * 100) : 0}%"></span></span><span class="hbar-val">${n}</span></button>`).join('')}</div>
        </section>
        <div class="ov-pair">
        <section class="ov-card">
          <div class="ov-card-head"><h3>Completed by STF year</h3><button class="link-more" data-go="completed">See all →</button></div>
          <div class="vbars" role="img" aria-label="Projects completed per STF year">
            <div class="vbars-grid"><span>${niceMax}</span><span>${niceMax / 2}</span><span>0</span></div>
            ${years.map(([y, n]) => `<button class="vbar-col ${y === fy ? 'cur' : ''}" data-go="fy:${y}" data-tip="<b>${esc(fyLabel(y))}</b><br>${n} project${n === 1 ? '' : 's'} completed">
              <span class="vbar-area"><span class="vbar" style="height:${n ? Math.max(3, n / niceMax * H) : 0}px"></span></span><span class="vbar-x">STF${String(y).slice(-2)}</span></button>`).join('')}
          </div>
        </section>
        <section class="ov-card">
          <div class="ov-card-head"><h3>Needs attention</h3></div>
          <ul class="ov-list">
            <li class="${stuck.length ? '' : 'zero'}"><button class="model-link" data-go="stuck">${stuck.length} open project${stuck.length === 1 ? '' : 's'} unchanged for 90+ days</button></li>
            <li class="${noTicket.length ? '' : 'zero'}"><button class="model-link" data-go="noticket">${noTicket.length} past consultation with no ticket number</button></li>
            <li class="${noRoom.length ? '' : 'zero'}"><button class="model-link" data-go="noroom">${noRoom.length} open project${noRoom.length === 1 ? '' : 's'} with no room linked</button></li>
          </ul>
          ${stuck.slice(0, 3).map(p => `<button class="ov-row" data-project="${esc(p.ProjectID)}">${phaseChip(p.Phase)}<span class="ov-row-t">${esc(p.Title)}</span><span class="muted">${daysSince(lastPhaseDate(p))} days</span></button>`).join('')}
        </section>
        </div>
        </div>
        <div class="ov-col">
        <section class="ov-card">
          <div class="ov-card-head"><h3>STF${yy} progress</h3></div>
          <div class="ov-hero"><span class="ov-num">${doneThis.length}</span><span class="ov-of">of ${goal} projects</span></div>
          <div class="progress" role="img" aria-label="${pct}% complete"><span style="width:${pct}%"></span></div>
          <p class="ov-sub" style="margin-top:8px">${pct}% done. ${plannedFY.length} FY${yy} project${plannedFY.length === 1 ? '' : 's'} still open.${committedAmt ? ` ${money(committedAmt)} recorded for STF${yy}.` : ''}</p>
          <div class="ov-card-head" style="margin:18px 0 6px"><h3 style="font-size:14px">Open projects by STF year</h3></div>
          ${byFY.map(([y, n, amt]) => `<button class="ov-row" data-go="fyopen:${esc(y)}"><span class="ov-row-t">${esc(y || 'No STF year')}</span><span class="muted">${amt ? money(amt) : ''}</span><b>${n}</b></button>`).join('') || '<div class="note">No open projects.</div>'}
        </section>
        <section class="ov-card">
          <div class="ov-card-head"><h3>Recently moved</h3><button class="link-more" data-go="list-recent">See list →</button></div>
          ${recent.map(p => `<button class="ov-row" data-project="${esc(p.ProjectID)}">${phaseChip(p.Phase)}<span class="ov-row-t">${esc(p.Title)}</span><span class="muted">${esc(lastPhaseDate(p))}</span></button>`).join('') || '<div class="note">No project dates recorded yet.</div>'}
        </section>
        </div>
      </div>`;
    $('#ov-new').onclick = () => newProject([]);
    wireProjectLinks($('#main')); wireTips($('#main'));
    $$('[data-go]').forEach(b => b.onclick = () => {
      const g = b.dataset.go; S.pj.q = ''; S.pj.fy = ''; S.pj.fund = ''; S.pj.phase = '';
      if (g === 'board') { S.page = 'projects'; S.pj.view = 'board'; }
      else if (g === 'completed') { S.page = 'projects'; S.pj.view = 'completed'; S.pj.year = fy; }
      else if (g.startsWith('fy:')) { S.page = 'projects'; S.pj.view = 'completed'; S.pj.year = +g.slice(3); }
      else if (g.startsWith('phase:')) { S.page = 'projects'; S.pj.view = 'list'; S.pj.phase = g.slice(6); S.pj.sort = 'stuck'; S.pj.dir = 'asc'; }
      else if (g === 'stuck') { S.page = 'projects'; S.pj.view = 'list'; S.pj.sort = 'stuck'; S.pj.dir = 'asc'; }
      else if (g === 'list-recent') { S.page = 'projects'; S.pj.view = 'list'; S.pj.sort = 'recent'; S.pj.dir = 'asc'; }
      else if (g === 'noticket' || g === 'noroom') { S.page = 'projects'; S.pj.view = 'list'; S.pj.sort = g === 'noroom' ? 'room' : 'ticket'; S.pj.dir = g === 'noroom' ? 'desc' : 'asc'; }
      else if (g.startsWith('fyopen:')) { S.page = 'projects'; S.pj.view = 'list'; S.pj.fy = g.slice(7); S.pj.sort = 'phase'; S.pj.dir = 'asc'; }
      else if (g === 'refresh') { S.page = 'reports'; S.rpOpen = Object.assign(S.rpOpen || {}, { lc: true }); }
      else if (g === 'rooms') { S.page = 'rooms'; S.ctlOnly = true; }
      $('#tip').hidden = true; renderAll(); window.scrollTo(0, 0);
    });
  }

  // ---- Project panel
  function newProject(roomIds) {
    const r = roomIds.length === 1 ? S.rooms.find(x => x.RoomID === roomIds[0]) : null;
    S.pj.draft = { ProjectID: '', Title: r ? roomName(r) + ' A/V System Upgrade' : '', Phase: 'Consultation', Rooms: roomIds.join(', '), 'Ticket ID': '',
      'Project Type': 'Complete Upgrade', 'Funding Source': '', 'STF Year': '', Amount: '', 'Proposed Install': '', Department: r ? r.Department || '' : '', Notes: '' };
    S.pj.open = null; S.pj.editing = true; S.pj.confirm = null;
    renderProjectPanel();
  }
  function openProject(id) {
    S.pj.multiBld = '';
    S.pj.open = id; S.pj.draft = null; S.pj.editing = false; S.pj.confirm = null; S.pj.hist = null;
    renderProjectPanel();
  }
  function closeProject() { S.pj.open = null; S.pj.draft = null; $('#overlay-root').innerHTML = ''; document.body.style.overflow = ''; }
  function renderProjectPanel() {
    const p = S.pj.draft || S.projects.find(x => x.ProjectID === S.pj.open);
    if (!p) { closeProject(); return; }
    S.open = null;
    const isNew = !p.ProjectID;
    const ed = S.pj.editing;
    const field = (f, kind) => {
      const v = p[f] == null ? '' : p[f];
      if (kind === 'select') { const opts = f === 'Project Type' ? PROJECT_TYPES : FUNDING; return `<select id="pf-${f.replace(/\W/g, '')}"><option value=""></option>${opts.concat(has(v) && !opts.includes(v) ? [v] : []).map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`; }
      if (kind === 'area') return `<textarea id="pf-${f.replace(/\W/g, '')}">${esc(v)}</textarea>`;
      return `<input id="pf-${f.replace(/\W/g, '')}" value="${esc(v)}" ${f === 'STF Year' ? 'placeholder="FY27"' : f === 'Amount' ? 'inputmode="decimal" placeholder="0"' : ''}>`;
    };
    const kinds = { 'Project Type': 'select', 'Funding Source': 'select', Notes: 'area' };
    const show = (f, v) => `<div class="row"><span class="k">${esc(f)}</span><span class="v ${has(v) ? '' : 'none'}">${has(v) ? v : 'Not recorded'}</span></div>`;
    const details = ed
      ? `<div class="pj-form">${PJ_FIELDS.map(f => `<label>${esc(f)}${field(f, kinds[f])}</label>`).join('')}
          ${!isNew ? `<details class="pj-dates"><summary>Phase dates</summary>${PHASES.concat('Cancelled').map(ph => `<label>${esc(ph)} on<input type="date" id="pd-${ph.replace(/\W/g, '')}" value="${esc(phaseDate(p, ph))}"></label>`).join('')}</details>` : ''}
          <div style="display:flex;gap:8px;margin-top:6px"><button class="btn primary small" id="pf-save">${isNew ? 'Create project' : 'Save'}</button><button class="btn small" id="pf-x">Cancel</button></div></div>`
      : PJ_FIELDS.map(f => show(f, f === 'Ticket ID' ? ticketLink(p) : f === 'Amount' ? esc(money(p.Amount)) : esc(p[f]))).join('')
        + `<button class="btn small" id="pf-edit" style="margin-top:8px">Edit details</button>`;
    const rooms = projRooms(p);
    const confirm = S.pj.confirm === 'Completed' ? `<div class="warn-box"><b>Mark this project completed?</b>
        <label style="display:block;margin:8px 0">Completed on <input type="date" id="pc-date" value="${new Date().toISOString().slice(0, 10)}"></label>
        ${rooms.length ? `Each linked room (${rooms.length}) gets its <b>Latest Update</b> and <b>Equipment Info As Of</b> set from this date, and its planned-upgrade fields cleared.` : 'No rooms are linked, so no room records change.'}
        <span style="display:flex;gap:8px;margin-top:8px"><button class="btn primary small" id="pc-yes">Mark completed</button><button class="btn small" id="pc-no">Cancel</button></span></div>`
      : S.pj.confirm === 'Cancelled' ? `<div class="warn-box"><b>Cancel this project?</b> It leaves the board and its rooms go back to their normal refresh status. You can reopen it later.
        <span style="display:flex;gap:8px;margin-top:8px"><button class="btn danger small" id="pc-yes">Cancel project</button><button class="btn small" id="pc-no">Keep it</button></span></div>`
      : S.pj.confirm === 'delete' ? `<div class="warn-box"><b>Delete this project permanently?</b> This can't be undone from the website. Its change history stays in the ChangeLog tab.
        <span style="display:flex;gap:8px;margin-top:8px"><button class="btn danger small" id="pc-yes">Yes, delete</button><button class="btn small" id="pc-no">Keep it</button></span></div>` : '';
    $('#overlay-root').innerHTML = `<div class="overlay" id="overlay"><aside class="panel pj-panel" role="dialog" aria-modal="true" aria-label="Project">
      <div class="panel-head"><button class="panel-close" id="close" aria-label="Close">×</button>
        <div class="panel-title" style="font-size:22px">${isNew ? 'New project' : esc(p.Title)}</div>
        <div class="panel-sub">${isNew ? 'Fill in what you know; everything can be changed later.' : `${esc(p.Phase)}${lastPhaseDate(p) ? ' since ' + esc(lastPhaseDate(p)) : ''}${has(p['Ticket ID']) ? ' · TeamDynamix ' : ''}`}${isNew ? '' : ticketLink(p)}</div></div>
      <div class="panel-body">
        <div class="section-title">Phase</div>
        ${stepper(p, true)}
        <p class="cat-note" style="margin:2px 0 0">Click a phase to move the project there. Dates are filled in automatically and can be changed under Edit details.</p>
        ${p.Phase === 'Cancelled' ? '<div class="note arch"><div><b>Cancelled</b>This project is off the board.</div></div>' : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px">${!isNew && p.Phase !== 'Cancelled' && p.Phase !== 'Completed' ? '<button class="btn small" id="pj-cancel">Cancel project</button>' : ''}
          ${!isNew && (p.Phase === 'Cancelled' || p.Phase === 'Completed') ? '<span class="cat-note" style="margin:0">Click a phase above to reopen it.</span>' : ''}</div>
        ${confirm}
        <div class="section-title">Rooms</div>
        <div class="chips">${rooms.map(id => `<span class="room-chip"><button class="model-link" data-openroom="${esc(id)}">${esc(roomLabelById(id))}</button><button class="x" data-unlink="${esc(id)}" aria-label="Remove ${esc(roomLabelById(id))}">×</button></span>`).join('') || '<span class="cat-note" style="margin:0">No rooms linked yet.</span>'}</div>
        <div class="inline-form" style="margin-top:8px"><label style="flex:1 1 240px">Add a room<input id="pj-addroom" list="pj-rooms" placeholder="Type building and room"></label>
          <datalist id="pj-rooms">${S.rooms.filter(r => !rooms.includes(r.RoomID)).map(r => `<option value="${esc(roomName(r))}">`).join('')}</datalist>
          <button class="btn small" id="pj-addroom-btn" type="button">Add</button></div>
        <details class="pj-multi" ${S.pj.multiBld ? 'open' : ''}><summary>Add several rooms from one building</summary>
          <select class="dd" id="pj-bld" aria-label="Building"><option value="">Pick a building…</option>${Array.from(new Set(S.rooms.map(r => r.Building))).sort(cmp).map(b => `<option ${b === S.pj.multiBld ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <div id="pj-bld-rooms"></div></details>
        <div class="section-title">Details</div>${details}
        ${isNew ? '' : '<div class="section-title">History</div><div id="pj-hist"><div class="loading">Loading history…</div></div>'}
      </div>
      ${!isNew && S.role === 'Admin' ? '<div class="save-bar"><span></span><button class="btn danger small" id="pj-del">Delete project</button></div>' : ''}
    </aside></div>`;
    document.body.style.overflow = 'hidden';
    $('#close').onclick = closeProject;
    $('#overlay').onclick = e => { if (e.target.id === 'overlay') closeProject(); };
    const read = () => {
      const out = Object.assign({}, p);
      if (ed) PJ_FIELDS.forEach(f => { const el = $('#pf-' + f.replace(/\W/g, '')); if (el) out[f] = el.value.trim(); });
      if (ed) PHASES.concat('Cancelled').forEach(ph => { const el = $('#pd-' + ph.replace(/\W/g, '')); if (el) out[ph + ' On'] = el.value; });
      if (has(out.Amount)) out.Amount = String(out.Amount).replace(/[$,]/g, '');
      if (has(out['STF Year'])) { const m = /(\d{2})\s*$/.exec(out['STF Year']); if (/^(fy|stf)?\s*\d{2}$/i.test(out['STF Year'].trim()) && m) out['STF Year'] = 'FY' + m[1]; }
      return out;
    };
    const save = async (proj, extra) => {
      if (!has(proj.Title)) { toast('Give the project a title', true); return; }
      if (proj.ProjectID === '' && S.pj.draft) { S.pj.draft = proj; }
      try {
        const d = await api('saveProject', Object.assign({ project: proj }, extra || {}));
        S.projects = d.projects;
        (d.rooms || []).forEach(nr => { const r = S.rooms.find(x => x.RoomID === nr.RoomID); if (r) Object.assign(r, nr); });
        S.pj.open = d.project.ProjectID; S.pj.draft = null; S.pj.editing = false; S.pj.confirm = null;
        toast(d.rooms && d.rooms.length ? `Project saved · ${d.rooms.length} room${d.rooms.length === 1 ? '' : 's'} updated` : 'Project saved');
        if (S.page === 'projects') renderProjects(); else if (S.page === 'reports') renderReports(); else renderRooms();
        renderProjectPanel();
      } catch (e) { toast(e.message, true); }
    };
    // phase clicks
    $$('[data-phase]').forEach(b => b.onclick = () => {
      const ph = b.dataset.phase;
      if (isNew || S.pj.draft) { p.Phase = ph; S.pj.draft = Object.assign(read(), { Phase: ph }); renderProjectPanel(); return; }
      if (ph === p.Phase) return;
      if (ph === 'Completed') { S.pj.confirm = 'Completed'; renderProjectPanel(); return; }
      const out = read(); out.Phase = ph; save(out);
    });
    if ($('#pj-cancel')) $('#pj-cancel').onclick = () => { S.pj.confirm = 'Cancelled'; renderProjectPanel(); };
    if ($('#pj-del')) $('#pj-del').onclick = () => { S.pj.confirm = 'delete'; renderProjectPanel(); };
    if ($('#pc-no')) $('#pc-no').onclick = () => { S.pj.confirm = null; renderProjectPanel(); };
    if ($('#pc-yes')) $('#pc-yes').onclick = async () => {
      const c = S.pj.confirm;
      if (c === 'delete') {
        try { S.projects = (await api('deleteProject', { projectId: p.ProjectID })).projects; toast('Project deleted'); closeProject(); if (S.page === 'projects') renderProjects(); }
        catch (e) { toast(e.message, true); }
        return;
      }
      const out = read(); out.Phase = c;
      if (c === 'Completed') out['Completed On'] = $('#pc-date').value || new Date().toISOString().slice(0, 10);
      save(out);
    };
    // rooms
    const addRoom = () => {
      const v = $('#pj-addroom').value.trim().toLowerCase(); if (!v) return;
      const r = S.rooms.find(x => roomName(x).toLowerCase() === v);
      if (!r) { toast('Pick a room from the list', true); return; }
      const out = read(); out.Rooms = rooms.concat(r.RoomID).join(', ');
      if (isNew) { S.pj.draft = out; renderProjectPanel(); return; }
      save(out);
    };
    $('#pj-addroom-btn').onclick = addRoom;
    const drawBld = () => {
      const b = S.pj.multiBld, box = $('#pj-bld-rooms');
      if (!b) { box.innerHTML = ''; return; }
      const list = S.rooms.filter(r => r.Building === b && !isArchived(r)).sort((x, y) => cmp(x.Room, y.Room));
      box.innerHTML = `<div class="check-grid">${list.map(r => `<label><input type="checkbox" value="${esc(r.RoomID)}" ${rooms.includes(r.RoomID) ? 'checked disabled' : ''}> ${esc(r.Room)}</label>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn small" type="button" id="pj-all">Select all</button><button class="btn primary small" type="button" id="pj-add-many">Add selected rooms</button></div>`;
      $('#pj-all').onclick = () => $$('#pj-bld-rooms input:not(:disabled)').forEach(c => { c.checked = true; });
      $('#pj-add-many').onclick = () => {
        const add = $$('#pj-bld-rooms input:checked:not(:disabled)').map(c => c.value);
        if (!add.length) { toast('Tick the rooms to add', true); return; }
        const out = read(); out.Rooms = rooms.concat(add).join(', ');
        if (isNew) { S.pj.draft = out; renderProjectPanel(); return; }
        save(out);
      };
    };
    $('#pj-bld').onchange = e => { S.pj.multiBld = e.target.value; drawBld(); };
    drawBld();
    $('#pj-addroom').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addRoom(); } };
    $$('[data-unlink]').forEach(b => b.onclick = () => {
      const out = read(); out.Rooms = rooms.filter(x => x !== b.dataset.unlink).join(', ');
      if (isNew) { S.pj.draft = out; renderProjectPanel(); return; }
      save(out);
    });
    $$('[data-openroom]').forEach(b => b.onclick = () => { const r = S.rooms.find(x => x.RoomID === b.dataset.openroom); S.pj.open = null; openRoom(r); });
    // details
    if ($('#pf-edit')) $('#pf-edit').onclick = () => { S.pj.editing = true; renderProjectPanel(); };
    if ($('#pf-x')) $('#pf-x').onclick = () => { if (isNew) { closeProject(); return; } S.pj.editing = false; renderProjectPanel(); };
    if ($('#pf-save')) $('#pf-save').onclick = () => { const out = read(); if (isNew && out.Phase === 'Completed') out['Completed On'] = out['Completed On'] || new Date().toISOString().slice(0, 10); save(out); };
    // history
    if (!isNew) (async () => {
      try {
        const d = await api('projectHistory', { projectId: p.ProjectID });
        if (S.pj.open !== p.ProjectID || !$('#pj-hist')) return;
        $('#pj-hist').innerHTML = d.history.length ? d.history.map(h => `<div class="history-item"><span class="who">${esc(h.User)}</span><span class="when">${esc(h.Timestamp)}</span>
          <div class="what">${esc(h.Action)}${has(h.Field) ? ' · ' + esc(h.Field) : ''}${has(h['Old Value']) || has(h['New Value']) ? `: ${esc(h['Old Value'] || '—')} → ${esc(h['New Value'] || '—')}` : ''}</div></div>`).join('')
          : '<div class="note">No changes recorded on this site yet.' + (p['Created By'] === 'Imported' ? ' This project was imported from the Project Master Sheet.' : '') + '</div>';
      } catch (e) { $('#pj-hist').innerHTML = `<div class="note">${esc(e.message)}</div>`; }
    })();
  }

  // ------------------------------------------------------------------ users page
  async function renderUsers() {
    const main = subHost();
    if (!S.users) {
      main.innerHTML = '<div class="loading">Loading users…</div>';
      try { S.users = (await api('listUsers')).users; } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    }
    const roles = ['Admin', 'Technician', 'Viewer', 'Student'];
    const row = (u, i) => S.userEditing === i
      ? `<tr><td><input id="ue-email" value="${esc(u.Email)}" aria-label="Email"></td><td><input id="ue-name" value="${esc(u.Name)}" aria-label="Name"></td>
          <td><select id="ue-role" aria-label="Role">${roles.map(r => `<option value="${r}" ${u.Role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select></td>
          <td><select id="ue-active" aria-label="Active"><option ${u.Active !== 'No' ? 'selected' : ''}>Yes</option><option ${u.Active === 'No' ? 'selected' : ''}>No</option></select></td>
          <td class="act"><button class="btn primary small" id="ue-save">Save</button> <button class="btn small" id="ue-x">Cancel</button></td></tr>`
      : `<tr style="${u.Active === 'No' ? 'opacity:.55' : ''}"><td>${esc(u.Email)}</td><td>${esc(u.Name)}</td><td>${esc(roleLabel(u.Role))}</td><td>${u.Active === 'No' ? 'No' : 'Yes'}</td>
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.pj.open && !S.pj.editing) { closeProject(); return; } if (e.key === 'Escape' && S.open && !S.roomEdit && !S.eqEditAll) closePanel(); });
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
