/**
 * Direct IT | Fujitsu campaign intake: backend
 *
 * Runs as the Cloudflare Pages "advanced mode" worker (_worker.js), so it deploys
 * with dashboard drag and drop. Every request that isn't /api/submit is served
 * from the static site as normal.
 *
 * POST /api/submit  (multipart/form-data)
 *   payload  JSON string of structured form fields (see the form's collect())
 *   brief    plain-text brief (same text as "Copy request")
 *   files    0..5 exclusion / suppression files
 *   cf-turnstile-response  (only when Turnstile is switched on)
 *
 * What it does
 *   1. Validates the request (size, file types, optional Turnstile check)
 *   2. Stores each file, plus the brief and payload, in a private R2 bucket
 *   3. Creates an item on the Fujitsu Campaign Tracker board in monday.com
 *   4. Posts the full brief as an update on that item and attaches the files
 *   5. Notifies the listed monday users
 *
 * Bindings and variables (Pages project > Settings)
 *   FILES             R2 bucket binding (required)
 *   MONDAY_TOKEN      monday API token, as an encrypted secret (required)
 *   MONDAY_BOARD_ID   e.g. 5030895974 (required)
 *   MONDAY_GROUP_ID   group for new briefs, e.g. group_mm6mbbxd (optional)
 *   NOTIFY_USER_IDS   comma-separated monday user ids to notify (optional)
 *   TURNSTILE_SECRET  Turnstile secret key; when set, a valid token is required (optional)
 *   MONDAY_API_URL    override for testing only (optional)
 */

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10MB per file
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;  // 25MB per submission
const ALLOWED_EXT = ['xlsx', 'xls', 'csv', 'txt'];
const PRICES = { profiled: 105, qualified: 423, cpm: 28 };

// Fujitsu Campaign Tracker column ids
const COL = {
  type: 'color_mm6mjqbk',
  stage: 'color_mm6mgcm9',
  targeting: 'color_mm6m9190',
  talReceived: 'boolean_mm6mpjmh',
  exclusion: 'color_mm6msw9f',
  content: 'color_mm6mjj5x',
  banners: 'color_mm6m2eew',
  profiling: 'color_mm6mbc3x',
  sow: 'color_mm6mc3z8',
  leadTarget: 'numeric_mm6m41k9',
  budget: 'numeric_mm6m3fqq',
  outstanding: 'long_text_mm6m510t',
};
const TYPE_LABEL = { dcd: 'ConSyn + Display', dc: 'ConSyn', tq: 'Straight tele', df: 'Digital first' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/submit') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      try {
        return await handleSubmit(request, env);
      } catch (err) {
        console.error('submit failed', err && err.stack || err);
        return json({ ok: false, error: 'Something went wrong on our side. Please copy the request and email it to your Direct IT account team.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleSubmit(request, env) {
  if (!env.FILES || !env.MONDAY_TOKEN || !env.MONDAY_BOARD_ID) {
    return json({ ok: false, error: 'Submission is not configured yet. Please copy the request and email it to your Direct IT account team.' }, 503);
  }
  const len = +request.headers.get('content-length') || 0;
  if (len > MAX_TOTAL_BYTES + 1024 * 1024) return json({ ok: false, error: 'Upload is too large (25MB maximum in total).' }, 413);

  const form = await request.formData();

  // Optional bot check
  if (env.TURNSTILE_SECRET) {
    const token = form.get('cf-turnstile-response');
    const ok = token && await verifyTurnstile(token, env.TURNSTILE_SECRET, request.headers.get('CF-Connecting-IP'));
    if (!ok) return json({ ok: false, error: 'Please complete the verification check and try again.' }, 400);
  }

  let p;
  try { p = JSON.parse(form.get('payload') || '{}'); } catch { return json({ ok: false, error: 'Invalid submission.' }, 400); }
  const brief = String(form.get('brief') || '').slice(0, 50000);
  if (!p.owner || !p.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) {
    return json({ ok: false, error: 'Please add your name and a valid email before submitting.' }, 400);
  }

  // Validate files
  const files = form.getAll('files').filter(f => f && typeof f === 'object' && f.size > 0);
  if (files.length > MAX_FILES) return json({ ok: false, error: `Attach up to ${MAX_FILES} files.` }, 400);
  let total = 0;
  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return json({ ok: false, error: `${f.name}: only .xlsx, .xls, .csv or .txt files can be attached.` }, 400);
    if (f.size > MAX_FILE_BYTES) return json({ ok: false, error: `${f.name} is over 10MB.` }, 400);
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) return json({ ok: false, error: 'Attachments are over 25MB in total.' }, 413);

  // 1. Store in R2
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD, Sydney time
  const ref = 'FJ-' + day.replace(/-/g, '') + '-' + crypto.randomUUID().slice(0, 6).toUpperCase();
  const prefix = `${day}/${ref}`;
  const stored = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const key = `${prefix}/${safeName(f.name)}`;
    await env.FILES.put(key, buf, { httpMetadata: { contentType: f.type || 'application/octet-stream' }, customMetadata: { ref, submittedBy: p.email } });
    stored.push({ name: f.name, key, size: f.size, buf, type: f.type });
  }
  await env.FILES.put(`${prefix}/brief.txt`, brief, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  await env.FILES.put(`${prefix}/payload.json`, JSON.stringify(p, null, 2), { httpMetadata: { contentType: 'application/json' } });

  // 2. Create the monday item
  const monday = mondayClient(env);
  const itemName = (p.campaignName || [p.solution, p.owner].filter(Boolean).join(' | ') || 'New Fujitsu brief').slice(0, 250);
  const columns = buildColumns(p, stored.length, ref);
  const created = await monday.query(
    `mutation ($board: ID!, $group: String, $name: String!, $cols: JSON!) {
      create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols, create_labels_if_missing: true) { id }
    }`,
    { board: String(env.MONDAY_BOARD_ID), group: env.MONDAY_GROUP_ID || null, name: itemName, cols: JSON.stringify(columns) }
  );
  const itemId = created.create_item.id;

  // 3. Brief as an update, with files attached
  const updateBody = `<p><b>New brief from the Fujitsu intake form</b> (ref ${esc(ref)})<br>From ${esc(p.owner)} &lt;${esc(p.email)}&gt;</p><pre>${esc(brief)}</pre>` +
    (stored.length ? `<p>Attachments (also archived in R2 under ${esc(prefix)}/): ${stored.map(s => esc(s.name)).join(', ')}</p>` : '');
  const upd = await monday.query(
    `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
    { item: itemId, body: updateBody }
  );
  const updateId = upd.create_update.id;

  const fileErrors = [];
  for (const s of stored) {
    try { await monday.uploadToUpdate(updateId, s); }
    catch (e) { fileErrors.push(s.name); console.error('file upload failed', s.name, e && e.message); }
  }
  if (fileErrors.length) {
    await monday.query(
      `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
      { item: itemId, body: `<p>These files didn't attach in monday but are safe in R2 under ${esc(prefix)}/: ${fileErrors.map(esc).join(', ')}</p>` }
    ).catch(() => {});
  }

  // 4. Notify
  const notify = String(env.NOTIFY_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const uid of notify) {
    await monday.query(
      `mutation ($user: ID!, $target: ID!, $text: String!) { create_notification(user_id: $user, target_id: $target, text: $text, target_type: Project) { text } }`,
      { user: uid, target: itemId, text: `New Fujitsu brief: ${itemName} from ${p.owner}${p.missing && p.missing.length ? ` (${p.missing.length} items still to confirm)` : ''}` }
    ).catch(e => console.error('notify failed', uid, e && e.message));
  }

  return json({ ok: true, ref, files: stored.length });
}

/* ---------- column mapping ---------- */
function buildColumns(p, fileCount, ref) {
  const t = p.ctype || '';
  const hasCS = ['dcd', 'dc', 'df'].includes(t);
  const hasQL = ['tq', 'df'].includes(t);
  const dispOn = t === 'dcd' || (t === 'df' && p.display === 'Yes');
  const csLeads = hasCS ? num(p.csLeads) : 0;
  const qLeads = hasQL ? num(p.qLeads) : 0;
  const budget = csLeads * PRICES.profiled + qLeads * PRICES.qualified + (dispOn ? num(p.displayBudget) : 0);

  const c = {};
  if (TYPE_LABEL[t]) c[COL.type] = { label: TYPE_LABEL[t] };
  c[COL.stage] = { label: 'Planning' };
  if (p.tal === 'Yes') c[COL.targeting] = { label: 'TAL' };
  else if (p.tal === 'No') c[COL.targeting] = { label: 'Whitespace' };
  if (p.tal === 'Yes' && p.talLink) c[COL.talReceived] = { checked: 'true' };

  const hasExclList = fileCount > 0 || !!p.exclLink;
  if (hasExclList) c[COL.exclusion] = { label: 'Received' };
  else if ((p.exclStandard && p.exclStandard.length) || p.exclOther) c[COL.exclusion] = { label: 'Needed' };

  if (hasCS) c[COL.content] = { label: p.assetsLink ? 'Received' : 'Needed' };
  else if (t === 'tq') c[COL.content] = { label: p.collateral ? 'Received' : 'Needed' };

  if (t) c[COL.banners] = { label: !dispOn ? 'N/A' : (p.bannerSource && p.bannerSource.startsWith('Fujitsu') && p.bannerLink ? 'Received' : 'Needed') };
  c[COL.profiling] = { label: p.questionsComplete ? 'Working on it' : 'Needed' };
  c[COL.sow] = { label: 'Not drafted' };
  if (csLeads + qLeads) c[COL.leadTarget] = String(csLeads + qLeads);
  if (budget) c[COL.budget] = String(budget);

  const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
  const lines = [`Brief submitted via intake form ${today} by ${p.owner} (ref ${ref}). Review and agree the brief before kick-off.`];
  if (p.questionsComplete) lines.push('Profiling questions proposed by Fujitsu: review and agree.');
  if (p.missing && p.missing.length) lines.push('Still to confirm: ' + p.missing.join('; '));
  c[COL.outstanding] = { text: lines.join('\n') };
  return c;
}

/* ---------- monday client ---------- */
function mondayClient(env) {
  const base = (env.MONDAY_API_URL || 'https://api.monday.com').replace(/\/$/, '');
  const headers = { Authorization: env.MONDAY_TOKEN };
  return {
    async query(query, variables) {
      const r = await fetch(`${base}/v2`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.errors || body.error_message) throw new Error('monday API: ' + JSON.stringify(body.errors || body.error_message || r.status));
      return body.data;
    },
    async uploadToUpdate(updateId, s) {
      const fd = new FormData();
      fd.append('query', `mutation ($file: File!) { add_file_to_update(update_id: ${Number(updateId)}, file: $file) { id } }`);
      fd.append('map', JSON.stringify({ attachment: 'variables.file' }));
      fd.append('attachment', new File([s.buf], s.name, { type: s.type || 'application/octet-stream' }));
      const r = await fetch(`${base}/v2/file`, { method: 'POST', headers, body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.errors || body.error_message) throw new Error(JSON.stringify(body.errors || body.error_message || r.status));
    },
  };
}

/* ---------- helpers ---------- */
async function verifyTurnstile(token, secret, ip) {
  const fd = new FormData();
  fd.append('secret', secret); fd.append('response', token);
  if (ip) fd.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  return !!d.success;
}
const num = v => Math.max(0, Math.round(Number(v) || 0));
const safeName = n => n.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
