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
 *   RESEND_API_KEY    Resend API key, encrypted secret; with BRIEF_EMAIL_TO set, each brief is emailed (optional)
 *   BRIEF_EMAIL_TO    comma-separated addresses to email each brief to (optional)
 *   BRIEF_EMAIL_FROM  sender (default: Resend's test sender, which only delivers to the Resend account owner)
 *   MONDAY_ITEM_URL   monday account URL for item links (default https://directit-global.monday.com)
 *   MONDAY_API_URL    override for testing only (optional)
 *   RESEND_API_URL    override for testing only (optional)
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      // Reports which settings this deployment can see (true/false only, never values)
      return json({ files: !!env.FILES, mondayToken: !!env.MONDAY_TOKEN, boardId: !!env.MONDAY_BOARD_ID, groupId: !!env.MONDAY_GROUP_ID, notify: !!env.NOTIFY_USER_IDS, turnstile: !!env.TURNSTILE_SECRET, email: !!(env.RESEND_API_KEY && env.BRIEF_EMAIL_TO) });
    }
    if (url.pathname === '/api/submit') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      try {
        return await handleSubmit(request, env, ctx);
      } catch (err) {
        console.error('submit failed', err && err.stack || err);
        return json({ ok: false, error: 'Something went wrong on our side. Please copy the request and email it to your Direct IT account team.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleSubmit(request, env, ctx) {
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

  // 5. Email the brief with the exclusion files attached (optional; never blocks or fails the submission)
  if (env.RESEND_API_KEY && env.BRIEF_EMAIL_TO) {
    const job = emailBrief(env, { ref, itemId, itemName, p, brief, stored, prefix })
      .catch(e => console.error('email failed', e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  }

  return json({ ok: true, ref, files: stored.length });
}

/* ---------- email ---------- */
const EMAIL_ATTACH_MAX = 15 * 1024 * 1024;
async function emailBrief(env, { ref, itemId, itemName, p, brief, stored, prefix }) {
  const to = String(env.BRIEF_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return;
  const itemUrl = `${(env.MONDAY_ITEM_URL || 'https://directit-global.monday.com').replace(/\/$/, '')}/boards/${env.MONDAY_BOARD_ID}/pulses/${itemId}`;
  const attachments = [], skipped = [];
  let used = 0;
  for (const s of stored) {
    if (used + s.size > EMAIL_ATTACH_MAX) { skipped.push(s); continue; }
    used += s.size;
    attachments.push({ filename: `Exclusions - ${s.name}`, content: b64(s.buf) });
  }
  const t = p.ctype || '';
  const hasCS = ['dcd', 'dc', 'df'].includes(t), hasQL = ['tq', 'df'].includes(t);
  const dispOn = t === 'dcd' || (t === 'df' && p.display === 'Yes');
  const cs = hasCS ? num(p.csLeads) : 0, ql = hasQL ? num(p.qLeads) : 0, disp = dispOn ? num(p.displayBudget) : 0;
  const budget = cs * PRICES.profiled + ql * PRICES.qualified + disp;
  const vols = [cs ? `${cs} profiled` : '', ql ? `${ql} qualified` : '', disp ? `display ${disp.toLocaleString('en-AU')} AUD` : ''].filter(Boolean).join(', ');
  const auDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const row = (k, v) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#5c6b85;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;color:#182233">${esc(v)}</td></tr>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#182233;max-width:760px">
  <div style="background:#182233;color:#fff;padding:14px 18px;border-bottom:4px solid #c5203a">
    <div style="font-size:11px;letter-spacing:1.5px;color:#f2a7b3;font-weight:bold">DIRECT IT x FUJITSU</div>
    <div style="font-size:19px;font-weight:bold;margin-top:2px">New Fujitsu brief: ${esc(itemName)}</div>
    <div style="font-size:13px;color:#b9c6dc;margin-top:2px">ref ${esc(ref)}</div>
  </div>
  <table style="border-collapse:collapse;margin:14px 0;font-size:14px">
    ${row('From', `${p.owner} <${p.email}>`)}${row('Type', TYPE_LABEL[t] || '')}${row('Solution', p.solution)}
    ${row('Dates', [p.start, p.end].map(auDate).filter(Boolean).join(' to '))}${row('Volumes', vols)}
    ${row('Budget', budget ? `${budget.toLocaleString('en-AU')} AUD ex GST` : '')}
    ${row('Exclusion files', stored.length ? String(stored.length) : '')}
    ${row('Still to confirm', p.missing && p.missing.length ? `${p.missing.length} item${p.missing.length > 1 ? 's' : ''}` : 'Nothing, brief is complete')}
  </table>
  <p><a href="${esc(itemUrl)}" style="background:#c5203a;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold">Open in monday</a>
  &nbsp; <span style="color:#5c6b85;font-size:13px">Reply to this email to reach ${esc(p.owner)} directly.</span></p>
  ${skipped.length ? `<p style="color:#b7791f">Too large to attach here, on the monday item and in storage: ${skipped.map(s => esc(s.name)).join(', ')}</p>` : ''}
  <pre style="background:#f8fafc;border:1px solid #dde3ec;border-radius:6px;padding:12px;font-family:Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap">${esc(brief)}</pre>
  <p style="color:#8a97ae;font-size:12px">Files are also archived in R2 under ${esc(prefix)}/ for 180 days.</p>
</div>`;
  const text = `New Fujitsu brief: ${itemName} (ref ${ref})\nFrom ${p.owner} <${p.email}>\nOpen in monday: ${itemUrl}\n\n${brief}`;
  const r = await fetch((env.RESEND_API_URL || 'https://api.resend.com').replace(/\/$/, '') + '/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.BRIEF_EMAIL_FROM || 'Direct IT Briefs <onboarding@resend.dev>',
      to, reply_to: p.email, subject: `New Fujitsu brief: ${itemName} (${ref})`, html, text, attachments,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
function b64(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
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
