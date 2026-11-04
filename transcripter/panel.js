// ─── Functions injected into the recording page (must be self-contained) ───

// Finds the meeting and transcript; opens the Transcript panel if needed.
async function pageDetect() {
  const job = window.__transcripter;
  const info = () => {
    const pane = document.querySelector('[data-testid="transcript-list-wrapper"]');
    const list = pane && pane.querySelector('.ms-List');
    const sub = list && list.querySelector('[id^="sub-entry-"]');
    const raw = document.title || '';
    const dm = raw.match(/-(\d{4})(\d{2})(\d{2})_\d{6}UTC-Meeting Recording/);
    const title = raw.replace(/-\d{8}_\d{6}UTC-Meeting Recording\.mp4.*$/, '').trim() || 'Meeting recording';
    const v = document.querySelector('video');
    return {
      found: !!sub,
      title,
      date: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null,
      total: sub ? parseInt(sub.getAttribute('aria-setsize'), 10) || null : null,
      duration: v && isFinite(v.duration) ? v.duration : null,
    };
  };
  let i = info();
  if (!i.found && !(job && job.state === 'running')) {
    const btn = [...document.querySelectorAll('button, [role="button"], [role="tab"]')]
      .find(b => /^\s*transcript\s*$/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (btn) {
      btn.click();
      for (let k = 0; k < 12 && !i.found; k++) { await new Promise(r => setTimeout(r, 300)); i = info(); }
    }
  }
  return { ...i, job: job ? { ...job, cancel: undefined } : null };
}

// Returns the current export job state.
function pageStatus() {
  const j = window.__transcripter;
  return j ? { ...j, cancel: undefined } : null;
}

function pageCancel() {
  if (window.__transcripter) window.__transcripter.cancel = true;
}

function pageStopAndSave() {
  if (window.__transcripter) window.__transcripter.stopSave = true;
}

function pageSaveAgain() {
  const r = window.__transcripter && window.__transcripter.result;
  if (!r) return false;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([r.text], { type: r.mime }));
  a.download = r.filename;
  document.body.appendChild(a); a.click(); a.remove();
  return true;
}

function pageClearJob() { delete window.__transcripter; }

// Starts the export in the background and returns immediately.
// opts: { format, timestamps, from, to }  (from/to in seconds, or null)
function pageStartExport(opts) {
  if (window.__transcripter && window.__transcripter.state === 'running') return;
  const job = window.__transcripter = { state: 'running', collected: 0, total: null, reached: null, cancel: false, stopSave: false, error: null, result: null };
  const from = opts.from ?? null, to = opts.to ?? null;

  (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clock = s => {
      s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
    };
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:220px;padding:10px 12px;border-radius:8px;background:#24406e;color:#fff;font:12px "Segoe UI",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)';
    badge.innerHTML = '<div id="__tx_msg">Transcripter: starting…</div><div style="height:4px;margin-top:6px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden"><div id="__tx_bar" style="height:100%;width:0;background:#7dd3be;transition:width .3s"></div></div>';
    document.body.appendChild(badge);
    const say = (t, pct) => {
      badge.querySelector('#__tx_msg').textContent = 'Transcripter: ' + t;
      if (pct != null) badge.querySelector('#__tx_bar').style.width = Math.min(100, pct) + '%';
    };
    const endBadge = (ms = 4000) => setTimeout(() => badge.remove(), ms);
    const cancelled = () => { job.state = 'cancelled'; say('cancelled'); endBadge(2000); };

    try {
      document.querySelectorAll('video').forEach(v => v.pause());
      const pane = document.querySelector('[data-testid="transcript-list-wrapper"]');
      const list = pane && pane.querySelector('.ms-List');
      if (!list) throw new Error('The Transcript panel is not open on this recording.');

      let scroller = pane.querySelector('#scrollToTargetTargetedFocusZone') || list.closest('[data-is-scrollable="true"]');
      if (!scroller) { let el = list.parentElement; while (el && el.scrollHeight <= el.clientHeight + 5) el = el.parentElement; scroller = el; }
      if (!scroller) throw new Error('Could not find the scrolling transcript list.');

      const firstSub = list.querySelector('[id^="sub-entry-"]');
      const total = firstSub ? parseInt(firstSub.getAttribute('aria-setsize'), 10) || null : null;
      job.total = total;
      const rows = new Map();
      let maxSecs = -1;

      const name = x => x.replace(/\s+/g, ' ').trim().replace(/^@(\d+)$/, 'Speaker $1');
      const parseLabel = s => {
        s = s.trim();
        const m = s.match(/^(.*?)\s+(?:(\d+)\s+hours?\s+)?(\d+)\s+minutes?\s+(\d+)\s+seconds?$/i);
        if (!m) return { speaker: name(s), time: '', secs: null };
        const secs = (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
        return { speaker: name(m[1]), time: clock(secs), secs };
      };
      const progress = () => {
        if (to != null && maxSecs >= 0) return Math.min(100, maxSecs / to * 100);
        return total ? rows.size / total * 100 : null;
      };
      const harvest = () => {
        list.querySelectorAll('.ms-List-cell[data-list-index]').forEach(cell => {
          const idx = +cell.dataset.listIndex;
          const label = cell.querySelector('[id^="timestampSpeakerAriaLabel-"]');
          const head = label ? parseLabel(label.textContent) : null;
          cell.querySelectorAll('[id^="sub-entry-"]').forEach((sub, i) => {
            const pos = +sub.getAttribute('aria-posinset') || (idx * 1000 + i);
            const text = sub.innerText.replace(/\s+/g, ' ').trim();
            if (text) rows.set(pos, i === 0 && head ? { text, ...head } : { text });
          });
          if (head && head.secs != null && head.secs > maxSecs) maxSecs = head.secs;
        });
        job.collected = rows.size;
        job.reached = maxSecs >= 0 ? clock(maxSecs) : null;
        say(`collecting ${rows.size}${total ? ' of ' + total : ''} lines${job.reached ? ' (at ' + job.reached + ')' : ''}…`, progress());
      };
      // Positions that should exist but haven't been collected, within [lo, hi]
      const missingIn = (lo, hi) => { let n = 0; for (let p = lo; p <= hi; p++) if (!rows.has(p)) n++; return n; };
      // The range of positions the export needs, given from/to
      const neededSpan = () => {
        const keys = [...rows.keys()].sort((a, b) => a - b);
        let lo = 1, hi = total || (keys.length ? keys[keys.length - 1] : 0);
        if (from != null) for (const k of keys) { const r = rows.get(k); if (r.secs != null) { if (r.secs <= from) lo = k; else break; } }
        if (to != null) for (const k of keys) { const r = rows.get(k); if (r.secs != null && r.secs > to) { hi = k - 1; break; } }
        return [lo, hi];
      };

      // 1. Wait for the list to finish loading and measuring itself
      say('preparing transcript…', 0);
      {
        let lastH = -1, steady = 0;
        const t0 = Date.now();
        while (steady < 4 && Date.now() - t0 < 20000 && !job.stopSave) {
          if (job.cancel) return cancelled();
          const h = scroller.scrollHeight;
          steady = h === lastH ? steady + 1 : 0;
          lastH = h;
          await sleep(500);
        }
      }

      // 2. Scroll and collect; stop on progress, not on scrollbar movement
      const deadline = Date.now() + 4 * 60 * 1000;
      scan: for (const delay of [350, 700]) {
        scroller.scrollTop = 0;
        await sleep(800);
        harvest();
        let furthest = 0, idle = 0, lastCount = rows.size;
        while (Date.now() < deadline) {
          if (job.cancel) return cancelled();
          if (job.stopSave) break scan;
          document.querySelectorAll('video').forEach(v => { if (!v.paused) v.pause(); });
          if (scroller.scrollTop < furthest - 50) scroller.scrollTop = furthest;   // list snapped back
          const before = scroller.scrollTop;
          scroller.scrollTop = before + Math.max(100, scroller.clientHeight * 0.6);
          await sleep(delay);
          harvest();
          furthest = Math.max(furthest, scroller.scrollTop);
          const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
          idle = rows.size > lastCount ? 0 : idle + 1;
          lastCount = rows.size;
          if (to != null && maxSecs > to) { const [lo, hi] = neededSpan(); if (missingIn(lo, hi) === 0) break scan; }   // past the end time
          if (total && rows.size >= total && idle >= 2) break;
          if (atBottom && idle >= 4) break;
          if (idle >= 40) break;
        }
        const [lo, hi] = neededSpan();
        const gap = missingIn(lo, hi);
        if (!gap || Date.now() >= deadline) break;
        say(`rechecking for ${gap} missing lines…`, progress());
      }
      if (!rows.size) throw new Error('No transcript lines were found on this page.');

      // 3. Order, carry times forward to continuation lines, apply the time range
      let ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
      let cur = null;
      ordered = ordered.map(([pos, r]) => { if (r.secs != null) cur = r.secs; return { pos, ...r, at: cur }; });
      const inRange = r => r.at == null || ((from == null || r.at >= from) && (to == null || r.at <= to));
      let picked = ordered.filter(inRange);
      // A turn that starts before "from" but continues past it: keep its lines from "from" on, with its speaker
      if (from != null && picked.length && picked[0].speaker === undefined) {
        const prev = [...ordered].reverse().find(r => r.pos < picked[0].pos && r.speaker !== undefined);
        if (prev && prev.speaker) picked[0] = { ...picked[0], speaker: prev.speaker, time: clock(from) };
      }
      if (!picked.length) throw new Error(job.stopSave ? 'Nothing in the chosen time range was collected before you stopped.' : 'No transcript lines fall in the chosen time range.');

      const [lo, hi] = neededSpan();
      const missing = missingIn(lo, hi);
      const stopped = job.stopSave;
      const lastAt = [...picked].reverse().find(r => r.at != null);
      const upTo = lastAt ? clock(lastAt.at) : null;

      // Merge consecutive turns by the same speaker; empty-label rows are events
      const blocks = [];
      for (const r of picked) {
        const last = blocks[blocks.length - 1];
        if (r.speaker === '') blocks.push({ event: true, lines: [r.text] });
        else if (r.speaker === undefined) { if (last) last.lines.push(r.text); else blocks.push({ event: true, lines: [r.text] }); }
        else if (last && !last.event && last.speaker === r.speaker) last.lines.push(r.text);
        else blocks.push({ speaker: r.speaker, time: r.time, lines: [r.text] });
      }

      const title = (document.title || 'Transcript')
        .replace(/-(\d{4})(\d{2})(\d{2})_\d{6}UTC-Meeting Recording\.mp4.*$/, ' ($1-$2-$3)').trim();
      const rangeLabel = (from != null || to != null) ? `${clock(from ?? 0)}–${to != null ? clock(to) : 'end'}` : null;
      const notes = [];
      if (rangeLabel) notes.push(`Excerpt: ${rangeLabel}`);
      if (stopped) notes.push(`Partial transcript: export was stopped early${upTo ? ', last line at ' + upTo : ''}`);
      else if (missing) notes.push(`${missing} line${missing === 1 ? '' : 's'} could not be collected`);

      const ts = b => opts.timestamps && b.time;
      let text;
      if (opts.format === 'md') {
        text = `# ${title}\n\n` + notes.map(n => `> ${n}\n\n`).join('') + blocks.map(b => b.event
          ? `*${b.lines.join(' ')}*`
          : `**${b.speaker}**${ts(b) ? ' (' + b.time + ')' : ''}  \n${b.lines.join(' ')}`).join('\n\n') + '\n';
      } else {
        text = `${title}\n${'='.repeat(title.length)}\n\n` + notes.map(n => `${n}\n`).join('') + (notes.length ? '\n' : '') + blocks.map(b => b.event
          ? `[${b.lines.join(' ')}]`
          : `${b.speaker}${ts(b) ? ' [' + b.time + ']' : ''}\n${b.lines.join(' ')}`).join('\n\n') + '\n';
      }
      const ext = opts.format === 'md' ? 'md' : 'txt';
      const mime = opts.format === 'md' ? 'text/markdown' : 'text/plain';
      const suffix = (rangeLabel ? ` ${rangeLabel.replace(/:/g, '.').replace('–', ' to ')}` : '') + (stopped ? ' (partial)' : '');
      const filename = (title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 110) + suffix).replace(/[\\/:*?"<>|]+/g, '_') + '.' + ext;

      const speech = blocks.filter(b => !b.event);
      // Timed segments for the AI prompt and the key-moments report (always with timestamps)
      const secsOf = t => { if (!t) return null; const p = t.split(':').map(Number); return p.reduce((a, x) => a * 60 + x, 0); };
      const segments = speech.map(b => ({ speaker: b.speaker, time: b.time || '', secs: secsOf(b.time), text: b.lines.join(' ') }));
      const meta = { title, date: (document.title.match(/-(\d{4})(\d{2})(\d{2})_\d{6}UTC/) || []).slice(1).join('-') || null };
      job.result = {
        segments, meta,
        text, filename, mime,
        count: picked.length, total, missing, stopped, upTo, range: rangeLabel,
        complete: !stopped && !missing,
        turns: speech.length,
        preview: speech.slice(0, 3).map(b => ({ speaker: b.speaker, time: opts.timestamps ? b.time : '', text: b.lines.join(' ') })),
      };

      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime }));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();

      job.state = 'done';
      say(stopped ? `saved ${picked.length} lines (partial)` : `saved ${picked.length} lines`, 100);
      endBadge();
    } catch (e) {
      job.state = 'error'; job.error = e.message;
      say(e.message); endBadge(8000);
    }
  })();
}

// Current video position and length, so it can be restored after capturing.
function pageVideoInfo() {
  const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  return v ? { time: v.currentTime, duration: isFinite(v.duration) ? v.duration : null, paused: v.paused } : null;
}

function pageSeek(t) {
  const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (v && t != null) v.currentTime = t;
}

// Seeks the recording to `secs`, waits for the frame, and returns it as a JPEG data URL.
// If the frame can't be read (protected or blank), returns the video's on-screen box instead,
// so the panel can capture the visible tab and crop it.
async function pageGrabFrame(secs, maxW) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!v) return { error: 'No video player was found on this page.' };
  if (!v.paused) v.pause();
  const end = isFinite(v.duration) ? Math.max(0, v.duration - 0.3) : secs;
  const t = Math.min(Math.max(0, secs), end);
  await new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; v.removeEventListener('seeked', fin); res(); } };
    v.addEventListener('seeked', fin);
    v.currentTime = t;
    setTimeout(fin, 10000);
  });
  for (let i = 0; i < 40 && v.readyState < 2; i++) await sleep(250);
  if (v.requestVideoFrameCallback) await Promise.race([new Promise(r => v.requestVideoFrameCallback(() => r())), sleep(1200)]);
  await sleep(350);

  v.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = v.getBoundingClientRect();
  const out = { at: v.currentTime, rect: { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, vidW: v.videoWidth, vidH: v.videoHeight } };
  if (v.readyState < 2) { out.blocked = 'not-loaded'; return out; }
  try {
    const W = v.videoWidth, H = v.videoHeight;
    if (!W || !H) { out.blocked = 'no-size'; return out; }
    const scale = Math.min(1, maxW / W);
    const c = document.createElement('canvas');
    c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] + d[i + 1] + d[i + 2] > 30) lit++; }
    if (lit / n < 0.005) { out.blocked = 'blank'; out.blankImage = c.toDataURL('image/jpeg', 0.85); return out; }
    out.image = c.toDataURL('image/jpeg', 0.85);
    out.method = 'video';
  } catch (e) {
    out.blocked = 'protected';
  }
  return out;
}

// ─── Panel logic ───

const $ = id => document.getElementById(id);
const views = ['loading', 'missing', 'ready', 'running', 'done', 'error'];
const show = v => views.forEach(n => { $('v-' + n).hidden = n !== v; });
const asPopup = new URLSearchParams(location.search).has('popup');
if (asPopup) document.body.classList.add('popup');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const prefs = {
  get format() { return store.get('format', 'txt'); },
  set format(v) { store.set('format', v); },
  get timestamps() { return store.get('timestamps', 'true') !== 'false'; },
  set timestamps(v) { store.set('timestamps', String(v)); },
};

let tabId = null, windowId = null, meeting = null, pollTimer = null, lastResult = null;
let capture = null;            // running key-moments capture
const momentDrafts = new Map(); // pasted AI replies, per tab

const run = async (func, args = [], id = tabId) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: id }, func, args });
  return res && res.result;
};

const clock = s => {
  if (s == null) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtDate = d => {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${y}`;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110);

// "12:30", "1:05:00", "45" (minutes) → seconds; '' → null; invalid → NaN
const parseClock = v => {
  v = v.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return +v * 60;
  const m = v.match(/^(?:(\d+):)?(\d+):([0-5]\d)$/);
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : NaN;
};

function readRange() {
  const fEl = $('opt-from'), tEl = $('opt-to');
  const from = parseClock(fEl.value), to = parseClock(tEl.value);
  let err = '';
  fEl.setAttribute('aria-invalid', String(Number.isNaN(from)));
  tEl.setAttribute('aria-invalid', String(Number.isNaN(to)));
  if (Number.isNaN(from) || Number.isNaN(to)) err = 'Use mm:ss, for example 12:30 or 1:05:00.';
  else if (from != null && to != null && from >= to) err = 'The start time must be before the end time.';
  else if (meeting && meeting.duration && from != null && from >= meeting.duration) err = `The recording is only ${clock(meeting.duration)} long.`;
  $('range-err').hidden = !err;
  $('range-err').textContent = err;
  return err ? null : { from, to };
}

// ─── Views ───

function renderReady(note) {
  $('m-title').textContent = meeting.title;
  $('m-meta').textContent = [fmtDate(meeting.date), meeting.total && `${meeting.total} lines`, meeting.duration && clock(meeting.duration)].filter(Boolean).join(' · ') || 'Transcript ready';
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.format === prefs.format)));
  $('opt-ts').checked = prefs.timestamps;
  $('ready-note').hidden = !note;
  $('ready-note').textContent = note || '';
  show('ready');
}

function renderRunning(job) {
  $('r-title').textContent = meeting ? meeting.title : '';
  const pct = job.total ? Math.round(job.collected / job.total * 100) : 0;
  $('bar-fill').style.width = pct + '%';
  $('bar').setAttribute('aria-valuenow', String(pct));
  $('r-status').textContent = !job.collected ? 'Preparing transcript…' : (job.total ? `Collecting ${job.collected} of ${job.total} lines` : `Collecting ${job.collected} lines`) + (job.reached ? ` · at ${job.reached}` : '') + '…';
  $('stop-save').disabled = !job.collected;
  show('running');
}

function renderDone(r) {
  lastResult = r;
  const what = r.range ? `${r.range} · ${r.count} lines · ${r.turns} turns` : `${r.count} of ${r.total || r.count} lines · ${r.turns} turns`;
  $('d-meta').textContent = r.stopped
    ? `Partial: saved up to ${r.upTo || 'where it stopped'}. ${r.count} lines · ${r.turns} turns`
    : r.missing ? `${what}. ${r.missing} line${r.missing === 1 ? '' : 's'} could not be collected; export again to retry.` : what;
  $('d-title').textContent = r.stopped ? 'Partial transcript saved' : 'Transcript saved';
  const pv = $('d-preview');
  pv.textContent = '';
  r.preview.forEach(p => {
    const who = document.createElement('p'); who.className = 'who'; who.textContent = p.speaker;
    if (p.time) { const t = document.createElement('span'); t.className = 'when'; t.textContent = p.time; who.appendChild(t); }
    const said = document.createElement('p'); said.className = 'said'; said.textContent = p.text;
    pv.append(who, said);
  });
  $('km').hidden = !(r.segments && r.segments.length);
  $('km-reply').value = momentDrafts.get(tabId) || '';
  updateParsed();
  if (!capture) showKm(km.report && km.reportTab === tabId ? 'done' : 'start');
  show('done');
}

function handleJob(job) {
  if (!job) return false;
  if (job.state === 'running') { renderRunning(job); startPolling(); return true; }
  if (job.state === 'done' && job.result) { renderDone(job.result); return true; }
  if (job.state === 'error') { $('error-msg').textContent = job.error || 'Something went wrong.'; show('error'); return true; }
  return false; // cancelled: fall through to ready
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling() {
  if (pollTimer) return;
  const id = tabId;
  pollTimer = setInterval(async () => {
    if (id !== tabId) return stopPolling();
    try {
      const job = await run(pageStatus);
      if (!job || job.state !== 'running') stopPolling();
      if (job && job.state === 'cancelled') renderReady('Export cancelled.');
      else handleJob(job);
    } catch { stopPolling(); }
  }, 400);
}

async function detect() {
  stopPolling();
  show('loading');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  windowId = tab && tab.windowId;
  if (!tab || !/^https:\/\/[^/]*\.sharepoint\.com\//.test(tab.url || '')) {
    $('missing-msg').textContent = 'Open a Teams or Stream meeting recording in this tab. Transcripter will pick it up automatically.';
    show('missing');
    return;
  }
  try {
    meeting = await run(pageDetect);
  } catch (e) {
    $('missing-msg').textContent = 'Transcripter can\'t read this page yet. Wait for it to finish loading, or reload it, then click Check again.';
    show('missing');
    return;
  }
  if (handleJob(meeting.job)) return;
  if (!meeting.found) {
    $('missing-msg').textContent = 'This recording has no transcript, or the Transcript panel couldn\'t be opened. Open it from the right side of the player and click Check again.';
    show('missing');
    return;
  }
  renderReady();
}

// Follow the active tab, so the panel always talks about what's on screen.
let detectTimer = null;
const redetect = () => {
  if (capture) return; // a capture is driving the recording tab; don't switch away
  clearTimeout(detectTimer);
  detectTimer = setTimeout(detect, 250);
};
chrome.tabs.onActivated.addListener(({ windowId: w }) => { if (w === windowId || windowId == null) redetect(); });
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (tab.active && tab.windowId === windowId && (info.status === 'complete' || info.url)) redetect();
});

// ─── Key moments ───

const km = { moments: [], report: null, reportTab: null };
const showKm = s => ['start', 'running', 'done'].forEach(n => { $('km-' + n).hidden = n !== s; });

function buildPrompt(r) {
  const head = `${r.meta?.title || 'Meeting'}${r.meta?.date && !(r.meta.title || '').includes(r.meta.date) ? ` (${r.meta.date})` : ''}${r.range ? `, excerpt ${r.range}` : ''}`;
  const body = r.segments.map(s => `[${s.time || '?'}] ${s.speaker}: ${s.text}`).join('\n');
  return `You are reviewing a meeting transcript. Find the key moments in the meeting: decisions, action items, disagreements, risks, and especially moments where something was shown on screen (a shared screen, slide, document, drawing, board, demo, or phrases like "as you can see", "on this slide", "let me share", "this screen").

Reply with ONLY a list in this exact format, one moment per line, in time order, with at most 15 lines:
mm:ss | Short title | One sentence on why it matters

Rules:
- Use the timestamp of the transcript line where the moment happens. Use h:mm:ss for times past one hour.
- For something shown on screen, use a timestamp a few seconds after it is first mentioned, so it is likely visible.
- No other text before or after the list.

Meeting: ${head}
Transcript:
${body}`;
}

// Accepts "12:34 | Title | Why", "[12:34] Title - why", "1. 12:34 — Title", markdown bullets, etc.
function parseMoments(text, duration) {
  const out = [], seen = new Set();
  for (let raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[*_`]/g, '').trim();
    const m = line.match(/^[\s\-•>]*(?:\d{1,2}[.)]\s+)?[\[(]?((?:\d{1,2}:)?\d{1,3}:[0-5]\d)[\])]?\s*(.*)$/);
    if (!m) continue;
    const p = m[1].split(':').map(Number);
    const secs = p.reduce((a, x) => a * 60 + x, 0);
    if (duration && secs > duration + 2) continue;
    if (seen.has(secs)) continue;
    let rest = m[2].replace(/^[-–—]\s*(?:\d{1,2}:)?\d{1,3}:[0-5]\d[\])]?\s*/, '').replace(/^[|:\-–—]\s*/, '');
    let parts = rest.split(/\s*\|\s*/).filter(Boolean);
    if (parts.length === 1) {
      const dash = rest.split(/\s+[–—-]\s+/);
      if (dash.length > 1) parts = [dash[0], dash.slice(1).join(' – ')];
    }
    seen.add(secs);
    out.push({ secs, time: clock(secs), title: (parts[0] || 'Moment').slice(0, 140), reason: parts.slice(1).join(' · ').slice(0, 400) });
  }
  return out.sort((a, b) => a.secs - b.secs).slice(0, 30);
}

function updateParsed() {
  const txt = $('km-reply').value;
  km.moments = parseMoments(txt, meeting && meeting.duration);
  const n = km.moments.length;
  $('km-found').textContent = !txt.trim() ? '' : n ? `${n} moment${n === 1 ? '' : 's'} found: ${km.moments.slice(0, 4).map(m => m.time).join(', ')}${n > 4 ? '…' : ''}` : 'No timestamps found. Lines should start with a time, like 12:34 | Title | Why.';
  $('km-found').classList.toggle('err', !!txt.trim() && !n);
  $('km-capture').disabled = !n;
}

function excerptFor(m, segments) {
  if (!segments) return [];
  let at = -1;
  segments.forEach((s, i) => { if (s.secs != null && s.secs <= m.secs) at = i; });
  const pick = new Set();
  if (at >= 0) pick.add(at);
  segments.forEach((s, i) => { if (s.secs != null && s.secs >= m.secs - 20 && s.secs <= m.secs + 75) pick.add(i); });
  return [...pick].sort((a, b) => a - b).slice(0, 5).map(i => ({ ...segments[i], here: i === at, text: segments[i].text.length > 600 ? segments[i].text.slice(0, 600) + '…' : segments[i].text }));
}

// Crops a visible-tab screenshot down to the video's box.
async function cropToVideo(dataUrl, rect, maxW) {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = img.width / rect.vw;
  let sx = Math.max(0, rect.x * k), sy = Math.max(0, rect.y * k);
  let sw = Math.min(img.width - sx, rect.w * k), sh = Math.min(img.height - sy, rect.h * k);
  // Trim letterboxing so only the picture remains
  if (rect.vidW && rect.vidH) {
    const ar = rect.vidW / rect.vidH;
    if (sw / sh > ar) { const w = sh * ar; sx += (sw - w) / 2; sw = w; } else { const h = sw / ar; sy += (sh - h) / 2; sh = h; }
  }
  if (sw < 10 || sh < 10) throw new Error('The video is not visible on screen.');
  const scale = Math.min(1, maxW / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function startCapture() {
  const moments = km.moments.slice();
  if (!moments.length) return;
  const id = tabId, win = windowId, r = lastResult;
  capture = { cancel: false, shots: [], tabFallback: false };
  showKm('running');
  $('km-bar-fill').style.width = '0%';
  let restore = null;
  try { restore = await run(pageVideoInfo, [], id); } catch {}
  let captureErr = null;
  for (let i = 0; i < moments.length; i++) {
    if (capture.cancel) break;
    const m = moments[i];
    $('km-status').textContent = `Capturing ${i + 1} of ${moments.length} · ${m.time}…`;
    let shot = { ...m, excerpt: excerptFor(m, r && r.segments) };
    try {
      const g = await run(pageGrabFrame, [m.secs, 1280], id);
      if (!g || g.error) throw new Error(g ? g.error : 'The recording tab didn\'t respond.');
      if (g.image) shot.image = g.image;
      else {
        try {
          await chrome.tabs.update(id, { active: true });
          await new Promise(res => setTimeout(res, 150));
          const full = await chrome.tabs.captureVisibleTab(win, { format: 'jpeg', quality: 88 });
          shot.image = await cropToVideo(full, g.rect, 1280);
          capture.tabFallback = true;
          await new Promise(res => setTimeout(res, 550)); // stay under the browser's capture rate limit
        } catch (e) {
          if (g.blankImage) { shot.image = g.blankImage; shot.blank = true; }
          else throw new Error(/activeTab|all_urls|permission/i.test(e.message || '') ? 'Transcripter wasn\'t allowed to capture the screen. Click the VR icon in the toolbar while the recording tab is open, then capture again.' : (e.message || String(e)));
        }
      }
    } catch (e) {
      shot.error = e.message || String(e);
      captureErr = captureErr || shot.error;
    }
    capture.shots.push(shot);
    $('km-bar-fill').style.width = Math.round((i + 1) / moments.length * 100) + '%';
  }
  try { if (restore) await run(pageSeek, [restore.time], id); } catch {}
  const shots = capture.shots, fallback = capture.tabFallback, cancelled = capture.cancel;
  capture = null;
  if (!shots.length) { showKm('start'); return; }
  km.report = { shots, fallback, cancelled, firstError: captureErr, title: (r?.meta?.title || meeting?.title || 'Meeting').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ''), date: r?.meta?.date || meeting?.date || null };
  km.reportTab = id;
  renderReport();
}

function renderReport() {
  const R = km.report;
  const ok = R.shots.filter(s => s.image).length, bad = R.shots.length - ok;
  $('km-done-meta').textContent = `${ok} of ${R.shots.length} moments captured` + (R.cancelled ? ' (stopped early)' : '') + '.';
  const notes = [];
  if (bad) notes.push(`${bad} couldn't be captured: ${R.firstError}`);
  if (R.fallback) notes.push('The video frames were protected, so the visible tab was captured and cropped to the video.');
  const blanks = R.shots.filter(s => s.blank).length;
  if (blanks) notes.push(`${blanks} frame${blanks === 1 ? ' was' : 's were'} blank at that moment; try a time a few seconds later.`);
  $('km-done-note').hidden = !notes.length;
  $('km-done-note').textContent = notes.join(' ');
  const grid = $('km-thumbs');
  grid.textContent = '';
  R.shots.forEach(s => {
    const f = document.createElement('figure');
    if (s.image) { const im = document.createElement('img'); im.src = s.image; im.alt = `Frame at ${s.time}`; f.appendChild(im); }
    else { const d = document.createElement('div'); d.className = 'noimg'; d.textContent = 'No image'; f.appendChild(d); }
    const c = document.createElement('figcaption'); c.textContent = `${s.time} ${s.title}`; f.appendChild(c);
    grid.appendChild(f);
  });
  showKm('done');
}

function reportHtml(R) {
  const date = fmtDate(R.date);
  const items = R.shots.map(s => `
<section class="m">
  <h2><span class="t">${esc(s.time)}</span> ${esc(s.title)}</h2>
  ${s.reason ? `<p class="why">${esc(s.reason)}</p>` : ''}
  ${s.image ? `<img src="${s.image}" alt="Recording at ${esc(s.time)}">` : `<div class="noimg">Screenshot not available${s.error ? ': ' + esc(s.error) : ''}</div>`}
  ${s.excerpt && s.excerpt.length ? `<div class="ex">${s.excerpt.map(e => `<p${e.here ? ' class="here"' : ''}><b>${esc(e.speaker)}</b> <span>${esc(e.time)}</span><br>${esc(e.text)}</p>`).join('')}</div>` : ''}
</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(R.title)} – key moments</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#1d2433;font:14px/1.55 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:36px 24px 56px}
header{border-bottom:2px solid #24406e;padding-bottom:14px;margin-bottom:8px}
h1{font-size:26px;line-height:1.2;margin:0 0 4px}.sub{color:#5b6475;margin:0}
.m{background:#fff;border:1px solid #e1e5ec;border-radius:10px;padding:20px 22px;margin-top:20px;break-inside:avoid;page-break-inside:avoid}
h2{font-size:17px;margin:0 0 4px}.t{display:inline-block;background:#e4ebf6;color:#24406e;border-radius:6px;padding:1px 8px;margin-right:6px;font-variant-numeric:tabular-nums}
.why{margin:0 0 12px;color:#3a4356}
img{display:block;max-width:100%;max-height:520px;width:auto;height:auto;margin:0 auto;border-radius:6px;border:1px solid #e1e5ec;background:#000}
.noimg{border:1px dashed #c9d1de;border-radius:6px;padding:28px;text-align:center;color:#8a92a3}
.ex{margin-top:12px;border-left:3px solid #e1e5ec;padding-left:12px}
.ex p{margin:0 0 8px;color:#5b6475;font-size:13px}.ex p:last-child{margin:0}
.ex b{color:#1d2433}.ex span{color:#8a92a3}
.ex p.here{color:#1d2433}.ex p.here b{color:#24406e}
footer{margin-top:28px;color:#8a92a3;font-size:12px}
@media print{body{background:#fff}.wrap{padding:0;max-width:none}.m{border-color:#d5dbe6}.noprint{display:none!important}}
</style></head><body><div class="wrap">
<header><h1>Key moments: ${esc(R.title)}</h1><p class="sub">${[date, `${R.shots.length} moments`].filter(Boolean).map(esc).join(' · ')}</p></header>
${items}
<footer>Moments were chosen by an AI from the transcript and may be incomplete or inaccurate. Screenshots are frames from the recording at each time. Made with Transcripter.</footer>
</div></body></html>`;
}

async function openReport() {
  const html = reportHtml(km.report);
  const id = 'report-' + Date.now();
  try {
    const all = await chrome.storage.local.get(null);
    const old = Object.keys(all).filter(k => k.startsWith('report-')).sort().slice(0, -2);
    if (old.length) await chrome.storage.local.remove(old);
    await chrome.storage.local.set({ [id]: { html, name: safeName(km.report.title) + ' - key moments' } });
    chrome.tabs.create({ url: chrome.runtime.getURL('report.html?id=' + id) });
  } catch (e) {
    $('km-done-note').hidden = false;
    $('km-done-note').textContent = 'Couldn\'t open the report: ' + e.message + '. Use Save HTML instead.';
  }
}

function saveReport() {
  const html = reportHtml(km.report);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = safeName(km.report.title) + ' - key moments.html';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const flash = (btn, text, back) => { btn.textContent = text; setTimeout(() => { btn.textContent = back; }, 1600); };

// ─── Events ───

document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  prefs.format = b.dataset.format;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
}));
$('opt-ts').addEventListener('change', e => { prefs.timestamps = e.target.checked; });
['opt-from', 'opt-to'].forEach(id => $(id).addEventListener('input', () => { if (!$('range-err').hidden) readRange(); }));

$('export').addEventListener('click', async () => {
  const range = readRange();
  if (!range) return;
  km.report = null;
  await run(pageStartExport, [{ format: prefs.format, timestamps: prefs.timestamps, ...range }]);
  renderRunning({ collected: 0, total: meeting.total });
  startPolling();
});
$('cancel').addEventListener('click', () => run(pageCancel));
$('stop-save').addEventListener('click', () => { $('stop-save').disabled = true; $('r-status').textContent = 'Saving what\'s collected…'; run(pageStopAndSave); });

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(lastResult.text); flash($('copy'), 'Copied', 'Copy'); }
  catch { flash($('copy'), 'Copy failed', 'Copy'); }
});
$('save-again').addEventListener('click', () => run(pageSaveAgain));
$('new-export').addEventListener('click', async () => { km.report = null; await run(pageClearJob); detect(); });
$('retry').addEventListener('click', detect);
$('error-retry').addEventListener('click', async () => { await run(pageClearJob); detect(); });

$('km-prompt').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(buildPrompt(lastResult)); flash($('km-prompt'), 'Prompt copied. Paste it into your AI', 'Copy AI prompt'); }
  catch { flash($('km-prompt'), 'Copy failed', 'Copy AI prompt'); }
});
$('km-reply').addEventListener('input', () => { momentDrafts.set(tabId, $('km-reply').value); updateParsed(); });
$('km-capture').addEventListener('click', startCapture);
$('km-cancel').addEventListener('click', () => { if (capture) { capture.cancel = true; $('km-status').textContent = 'Stopping after this moment…'; } });
$('km-open').addEventListener('click', openReport);
$('km-save').addEventListener('click', saveReport);
$('km-again').addEventListener('click', () => { km.report = null; showKm('start'); });

$('help').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }));

detect();
