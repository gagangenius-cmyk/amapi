'use strict';
// AAYME admin console. Plain JS, no build step. Everything dynamic is inserted with textContent (never as markup), so
// data from users can not inject markup. The access token lives in memory only: closing the tab signs you out.
const API = '/api/v1';
let access = null, refresh = null, me = null;
const $ = (s, r = document) => r.querySelector(s);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

async function api(path, opts = {}, retry = true) {
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(access && { Authorization: 'Bearer ' + access }) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && retry && refresh && j.error?.code === 'UNAUTHENTICATED') {
    const r = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) });
    if (r.ok) { const t = await r.json(); access = t.access_token; refresh = t.refresh_token; return api(path, opts, false); }
    signOut(); throw new Error('Session expired');
  }
  if (!res.ok) { const e = new Error(j.error?.message || 'Request failed'); e.code = j.error?.code; throw e; }
  return j;
}

function signOut() { access = refresh = me = null; render(); }
const when = (d) => (d ? new Date(d).toLocaleString() : '');
const money = (v) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- login ----------
function loginView() {
  const phone = el('input', { placeholder: 'Phone', inputmode: 'numeric', maxlength: 10, autocomplete: 'username', 'aria-label': 'Phone' });
  const pw = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const code = el('input', { placeholder: 'Email code (press Sign in first to get one)', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', 'aria-label': 'Email code' });
  const err = el('div', { class: 'err', role: 'alert' });
  const go = async () => {
    err.textContent = '';
    try {
      const t = await api('/auth/login', { method: 'POST', body: { phone: phone.value.trim(), password: pw.value, ...(code.value && { totp: code.value.trim() }) } });
      if (t.role !== 'admin') throw new Error('This console is for platform administrators only');
      access = t.access_token; refresh = t.refresh_token; me = await api('/me'); render();
    } catch (e) { err.textContent = e.message; }
  };
  [phone, pw, code].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && go()));
  return el('form', { class: 'login', onsubmit: (e) => e.preventDefault() },
    el('h2', {}, 'AAYME Admin'), phone, pw, code, err, el('button', { class: 'primary', type: 'button', onclick: go }, 'Sign in'));
}

// ---------- shared pieces ----------
const TABS = ['Overview', 'Distributors', 'Subscriptions', 'Plans', 'Users', 'Audit log', 'Security'];
let tab = 'Overview';

function table(head, rows, empty) {
  if (!rows.length) return el('p', { class: 'muted' }, empty || 'Nothing to show.');
  return el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c)))))));
}

// ---------- views ----------
async function overview() {
  const s = await api('/admin/stats');
  const c = (await api('/admin/commissions')).commissions;
  const k = (label, v) => el('div', { class: 'kpi' }, el('b', {}, v), el('span', {}, label));
  const u = s.users;
  return [
    el('div', { class: 'grid' },
      k('Distributors', u.distributor?.count ?? 0), k('Retailers', u.retailer?.count ?? 0), k('Employees', u.employee?.count ?? 0),
      k('Orders (all time)', s.orders), k('Orders in last 24 h', s.orders_today), k('Order value (GMV)', money(s.gmv)),
      k('Owed by retailers', money(s.receivables)), k('Subscriptions ending in 7 days', s.subscriptions_expiring_7d), k('Failed logins in 24 h', s.failed_logins_24h)),
    el('h3', {}, 'Commission on out-of-hierarchy orders (delivered)'),
    table(['Distributor', 'Orders', 'Gross', 'Commission'], c.map((r) => [r.business_name, r.orders, money(r.gross_paise / 100), money(r.commission_paise / 100)]), 'No commissionable orders yet.'),
  ];
}

async function distributors() {
  const { distributors: list, permission_catalog: cat } = await api('/admin/distributors');
  const msg = el('div', { class: 'err' });
  const act = async (fn) => { msg.textContent = ''; try { await fn(); show(); } catch (e) { msg.textContent = e.message; } };
  const put = (d, body) => api('/distributor/' + d.id + '/admin', { method: 'PUT', body });

  // One checkbox per switch; Save sends only what the admin sees ticked.
  const permissions = (d) => {
    const boxes = cat.map((p) => {
      const box = el('input', { type: 'checkbox', id: `p-${d.id}-${p.key}` });
      box.checked = !!d.permissions[p.key];
      return { key: p.key, box, row: el('label', { class: 'perm', title: p.help }, box, ' ', p.label, el('span', { class: 'muted' }, ' \u2013 ' + p.help)) };
    });
    return el('details', {}, el('summary', {}, 'Permissions'),
      el('div', { class: 'permbox' }, boxes.map((b) => b.row),
        el('button', { class: 'primary', onclick: () => act(() => put(d, { permissions: Object.fromEntries(boxes.map((b) => [b.key, b.box.checked])) })) }, 'Save permissions')));
  };

  return [msg, table(['Business', 'Phone', 'Retailers', 'Orders', 'Plan', 'Subscription ends', 'Commission', 'Permissions', 'Actions'], list.map((d) => [
    d.business_name, d.phone, d.retailers, d.orders, d.plan_name || '',
    el('span', { class: 'pill ' + (new Date(d.subscription_ends_at) > new Date() ? 'ok' : 'bad') }, when(d.subscription_ends_at)),
    (d.commission_rate_bps / 100) + '%',
    permissions(d),
    el('span', { class: 'row' },
      el('button', { onclick: () => act(() => put(d, { extend_days: 30 })) }, '+30 days'),
      el('button', { onclick: () => act(() => put(d, { extend_days: 365 })) }, '+1 year'),
      el('button', { onclick: () => {
        const v = prompt('Commission % for orders outside the pinned distributor', String(d.commission_rate_bps / 100));
        if (v != null && v !== '' && !isNaN(+v)) act(() => put(d, { commission_rate_bps: Math.round(+v * 100) }));
      } }, 'Commission\u2026')),
  ]))];
}

// ---- subscription payments waiting for a decision, and the recent ones
async function subscriptions() {
  const msg = el('div', { class: 'err' });
  const act = async (fn) => { msg.textContent = ''; try { await fn(); show(); } catch (e) { msg.textContent = e.message; } };
  const pending = (await api('/admin/subscription-payments?status=pending')).payments;
  const recent = (await api('/admin/subscription-payments?status=all')).payments.filter((p) => p.status !== 'pending').slice(0, 20);
  return [msg, el('h3', {}, 'Waiting for you (' + pending.length + ')'),
    el('p', { class: 'muted' }, 'Check each UTR in the company bank / UPI app. Confirming adds the plan\'s days to the distributor.'),
    table(['When', 'Distributor', 'Plan', 'Amount', 'UTR', 'Currently valid until', ''], pending.map((p) => [
      when(p.created_at), p.business_name + ' (' + p.phone + ')', p.plan_name + ' \u00b7 ' + p.days + ' d', money(p.amount), p.utr || '', when(p.current_ends_at),
      el('span', { class: 'row' },
        el('button', { class: 'primary', onclick: () => act(() => api('/admin/subscription-payments/' + p.id + '/confirm', { method: 'POST' })) }, 'Confirm received'),
        el('button', { class: 'danger', onclick: () => { const n = prompt('Why is it being rejected?', 'We could not find this payment in our bank'); if (n !== null) act(() => api('/admin/subscription-payments/' + p.id + '/reject', { method: 'POST', body: { note: n } })); } }, 'Reject')),
    ]), 'Nothing waiting.'),
    el('h3', {}, 'Recent'), table(['When', 'Distributor', 'Plan', 'Amount', 'How', 'Status'], recent.map((p) => [when(p.created_at), p.business_name, p.plan_name, money(p.amount), p.method === 'gateway' ? 'Card / online' : 'UPI ' + (p.utr || ''), el('span', { class: 'pill ' + (p.status === 'confirmed' ? 'ok' : 'bad') }, p.status)]), 'No decided payments yet.')];
}

// ---- plans and the company's own payment details
async function plans() {
  const msg = el('div', { class: 'err' });
  const act = async (fn) => { msg.textContent = ''; try { await fn(); show(); } catch (e) { msg.textContent = e.message; } };
  const list = (await api('/admin/plans')).plans;
  const company = await api('/admin/settings');

  const upi = el('input', { value: company.upi_id || '', placeholder: 'company@bank', 'aria-label': 'Company UPI id' });
  const payee = el('input', { value: company.payee || '', placeholder: 'Name shown in the UPI app', 'aria-label': 'Payee name' });

  const name = el('input', { placeholder: 'Plan name', 'aria-label': 'New plan name' });
  const days = el('input', { placeholder: 'Days', inputmode: 'numeric', size: 5, 'aria-label': 'New plan days' });
  const price = el('input', { placeholder: 'Price \u20b9', inputmode: 'decimal', size: 8, 'aria-label': 'New plan price' });

  return [msg,
    el('h3', {}, 'Where distributors pay the subscription'),
    el('div', { class: 'row' }, upi, payee, el('button', { class: 'primary', onclick: () => act(() => api('/admin/settings', { method: 'PUT', body: { company_upi_id: upi.value.trim(), company_payee: payee.value.trim() || undefined } })) }, 'Save')),
    el('h3', {}, 'Plans'),
    table(['Plan', 'Days', 'Price', 'Offered', ''], list.map((p) => [p.name, p.days, money(p.price), el('span', { class: 'pill ' + (p.is_active ? 'ok' : 'bad') }, p.is_active ? 'yes' : 'hidden'),
      el('span', { class: 'row' },
        el('button', { onclick: () => { const v = prompt('New price in rupees for "' + p.name + '"', p.price); if (v) act(() => api('/admin/plans/' + p.id, { method: 'PUT', body: { price: v } })); } }, 'Change price'),
        el('button', { onclick: () => act(() => api('/admin/plans/' + p.id, { method: 'PUT', body: { is_active: !p.is_active } })) }, p.is_active ? 'Hide' : 'Show'))])),
    el('h3', {}, 'Add a plan'),
    el('div', { class: 'row' }, name, days, price, el('button', { class: 'primary', onclick: () => act(() => api('/admin/plans', { method: 'POST', body: { name: name.value.trim(), days: Number(days.value), price: price.value.trim() } })) }, 'Add plan')),
    el('p', { class: 'muted' }, 'Changing a price or length never changes what someone already paid for.')];
}

async function users() {
  const q = el('input', { placeholder: 'Search name, phone, email', 'aria-label': 'Search users' });
  const role = el('select', { 'aria-label': 'Role' }, ['', 'distributor', 'retailer', 'employee', 'admin'].map((r) => el('option', { value: r }, r || 'All roles')));
  const out = el('div');
  const msg = el('div', { class: 'err' });
  const load = async () => {
    const { users: list } = await api('/admin/users?' + new URLSearchParams({ ...(q.value && { q: q.value }), ...(role.value && { role: role.value }) }));
    out.replaceChildren(table(['ID', 'Role', 'Name', 'Business', 'Phone', 'Email', 'Joined', 'Status', ''], list.map((u) => [
      u.id, u.role, u.name, u.business || '', u.phone,
      u.email ? [u.email, ' ', el('span', { class: 'pill ' + (u.email_verified ? 'ok' : '') }, u.email_verified ? 'verified' : 'unverified')] : '',
      when(u.created_at),
      el('span', { class: 'pill ' + (u.is_active ? 'ok' : 'bad') }, u.is_active ? 'active' : 'suspended'),
      u.role === 'admin' ? '' : el('button', { class: u.is_active ? 'danger' : '', onclick: async () => {
        const reason = u.is_active ? prompt('Reason for suspending ' + u.name + '?') : '';
        if (u.is_active && reason === null) return;
        msg.textContent = '';
        try { await api('/admin/users/' + u.id + '/status', { method: 'POST', body: { is_active: !u.is_active, ...(reason && { reason }) } }); load(); }
        catch (e) { msg.textContent = e.message; }
      } }, u.is_active ? 'Suspend' : 'Restore'),
    ]), 'No users match.'));
  };
  q.addEventListener('keydown', (e) => e.key === 'Enter' && load());
  role.addEventListener('change', load);
  await load();
  return [el('div', { class: 'row' }, q, role, el('button', { onclick: load }, 'Search')), msg, out];
}

async function auditLog() {
  const action = el('input', { placeholder: 'Action starts with… e.g. auth.', 'aria-label': 'Action filter' });
  const out = el('div');
  const rows = [];
  let before = null;
  const draw = (more) => out.replaceChildren(table(['#', 'When', 'Who', 'Action', 'Entity', 'Details'], rows, 'No entries.'), more ? el('button', { onclick: () => load(true) }, 'Load older') : '');
  const load = async (more) => {
    if (!more) { rows.length = 0; before = null; }
    const r = await api('/admin/audit?' + new URLSearchParams({ limit: 50, ...(action.value && { action: action.value }), ...(before && { before }) }));
    for (const e of r.entries) {
      rows.push([e.id, when(e.created_at), e.actor_name ? e.actor_name + ' (' + e.actor_role + ')' : e.actor_id ? '#' + e.actor_id : 'system',
        e.action, e.entity + (e.entity_id ? ' #' + e.entity_id : ''), e.meta ? el('code', {}, JSON.stringify(e.meta)) : '']);
    }
    before = r.next_before; draw(!!before);
  };
  action.addEventListener('keydown', (e) => e.key === 'Enter' && load());
  await load();
  return [el('div', { class: 'row' }, action, el('button', { onclick: () => load() }, 'Filter')), out];
}

async function security() {
  me = await api('/me');
  const box = el('div');
  const err = el('div', { class: 'err', role: 'alert' });
  if (me.two_factor) {
    const code = el('input', { placeholder: 'Current code', maxlength: 6, inputmode: 'numeric', 'aria-label': 'Current code' });
    const pw = el('input', { type: 'password', placeholder: 'Password', 'aria-label': 'Password' });
    box.append(el('p', {}, el('span', { class: 'pill ok' }, 'Two-factor is ON')),
      el('div', { class: 'row' }, pw, code, el('button', { class: 'danger', onclick: async () => {
        try { await api('/auth/2fa/disable', { method: 'POST', body: { code: code.value, password: pw.value } }); show(); } catch (e) { err.textContent = e.message; }
      } }, 'Turn off')));
  } else {
    box.append(el('p', {}, el('span', { class: 'pill bad' }, 'Two-factor is OFF'), ' Admin accounts should use an authenticator app.'),
      el('button', { class: 'primary', onclick: async () => {
        try {
          const s = await api('/auth/2fa/setup', { method: 'POST' });
          const code = el('input', { placeholder: '6-digit code', maxlength: 6, inputmode: 'numeric', 'aria-label': '6-digit code' });
          box.replaceChildren(
            el('p', {}, 'Add this key in Google Authenticator, Authy or 1Password (time-based, 6 digits):'),
            el('p', {}, el('code', {}, s.secret)),
            el('div', { class: 'row' }, code, el('button', { class: 'primary', onclick: async () => {
              try { await api('/auth/2fa/enable', { method: 'POST', body: { code: code.value } }); show(); } catch (e) { err.textContent = e.message; }
            } }, 'Confirm and turn on')));
        } catch (e) { err.textContent = e.message; }
      } }, 'Set up two-factor'));
  }
  const { sessions } = await api('/me/sessions');
  return [el('h3', {}, 'Two-factor authentication'), box, err, el('h3', {}, 'Your active sessions'),
    table(['Device', 'IP', 'Started', 'Last active', ''], sessions.map((s) => [s.device || 'Unknown', s.ip || '', when(s.started_at), when(s.last_active_at),
      el('button', { class: 'danger', onclick: async () => { await api('/me/sessions/' + s.id, { method: 'DELETE' }); show(); } }, 'Sign out')]))];
}

const VIEWS = { Overview: overview, Distributors: distributors, Subscriptions: subscriptions, Plans: plans, Users: users, 'Audit log': auditLog, Security: security };

async function show() {
  const body = $('#panel');
  if (!body) return;
  body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try { body.replaceChildren(...[await VIEWS[tab]()].flat()); }
  catch (e) {
    if (e.code === 'TWO_FACTOR_REQUIRED') { tab = 'Security'; render(); return; }
    body.replaceChildren(el('div', { class: 'err', role: 'alert' }, e.message));
  }
}

function render() {
  const app = $('#app');
  if (!access) return app.replaceChildren(loginView());
  app.replaceChildren(
    el('header', {}, el('h1', {}, 'AAYME Admin'), el('span', {}, me?.name || ''),
      el('button', { onclick: async () => { try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* signing out anyway */ } signOut(); } }, 'Sign out')),
    el('nav', { role: 'tablist' }, TABS.map((t) => el('button', { role: 'tab', 'aria-selected': t === tab ? 'true' : 'false', onclick: () => { tab = t; render(); } }, t))),
    el('main', {}, el('div', { class: 'panel', id: 'panel' })));
  show();
}
render();
