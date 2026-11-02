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
      job.result = {
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

// ─── Popup logic ───

const $ = id => document.getElementById(id);
const views = ['loading', 'missing', 'ready', 'running', 'done', 'error'];
const show = v => views.forEach(n => { $('v-' + n).hidden = n !== v; });

const prefs = {
  get format() { return localStorage.getItem('format') || 'txt'; },
  set format(v) { localStorage.setItem('format', v); },
  get timestamps() { return localStorage.getItem('timestamps') !== 'false'; },
  set timestamps(v) { localStorage.setItem('timestamps', String(v)); },
};

let tabId = null, meeting = null, pollTimer = null;

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
  else if (meeting && meeting.duration && from != null && from >= meeting.duration) err = `The recording is only ${fmtDur(meeting.duration)} long.`;
  $('range-err').hidden = !err;
  $('range-err').textContent = err;
  return err ? null : { from, to };
}

const run = async (func, args = []) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res && res.result;
};

const fmtDate = d => {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${y}`;
};
const fmtDur = s => {
  if (!s) return null;
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

function renderReady(note) {
  $('m-title').textContent = meeting.title;
  $('m-meta').textContent = [fmtDate(meeting.date), meeting.total && `${meeting.total} lines`, fmtDur(meeting.duration)].filter(Boolean).join(' · ') || 'Transcript ready';
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
  document.querySelector('.bar').setAttribute('aria-valuenow', String(pct));
  $('r-status').textContent = (job.total ? `Collecting ${job.collected} of ${job.total} lines` : `Collecting ${job.collected} lines`) + (job.reached ? ` · at ${job.reached}` : '') + '…';
  $('stop-save').disabled = !job.collected;
  show('running');
}

function renderDone(r) {
  const what = r.range ? `${r.range} · ${r.count} lines · ${r.turns} turns` : `${r.count} of ${r.total || r.count} lines · ${r.turns} turns`;
  $('d-meta').textContent = r.stopped
    ? `Partial: saved up to ${r.upTo || 'where it stopped'}. ${r.count} lines · ${r.turns} turns`
    : r.missing ? `${what}. ${r.missing} line${r.missing === 1 ? '' : 's'} could not be collected; export again to retry.` : what;
  document.querySelector('#v-done .title').textContent = r.stopped ? 'Partial transcript saved' : 'Transcript saved';
  const pv = $('d-preview');
  pv.textContent = '';
  r.preview.forEach(p => {
    const who = document.createElement('p'); who.className = 'who'; who.textContent = p.speaker;
    if (p.time) { const t = document.createElement('span'); t.className = 'when'; t.textContent = p.time; who.appendChild(t); }
    const said = document.createElement('p'); said.className = 'said'; said.textContent = p.text;
    pv.append(who, said);
  });
  lastText = r.text;
  show('done');
}

let lastText = '';

function handleJob(job) {
  if (!job) return false;
  if (job.state === 'running') { renderRunning(job); startPolling(); return true; }
  if (job.state === 'done' && job.result) { renderDone(job.result); return true; }
  if (job.state === 'error') { $('error-msg').textContent = job.error || 'Something went wrong.'; show('error'); return true; }
  return false; // cancelled: fall through to ready
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const job = await run(pageStatus);
      if (!job || job.state !== 'running') { clearInterval(pollTimer); pollTimer = null; }
      if (job && job.state === 'cancelled') renderReady('Export cancelled.');
      else handleJob(job);
    } catch { clearInterval(pollTimer); pollTimer = null; }
  }, 400);
}

async function detect() {
  show('loading');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (!tab || !/^https:\/\/[^/]*\.sharepoint\.com\//.test(tab.url || '')) {
    $('missing-msg').textContent = 'Open a Teams meeting recording in this tab, then open Transcripter again.';
    show('missing');
    return;
  }
  try {
    meeting = await run(pageDetect);
  } catch (e) {
    $('missing-msg').textContent = 'Transcripter can\'t read this page. Reload the recording and try again.';
    show('missing');
    return;
  }
  if (handleJob(meeting.job)) return;
  if (!meeting.found) {
    $('missing-msg').textContent = 'This recording has no transcript, or the Transcript panel couldn\'t be opened. Open it from the right side of the player and check again.';
    show('missing');
    return;
  }
  renderReady();
}

// ─── Events ───

document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  prefs.format = b.dataset.format;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
}));
$('opt-ts').addEventListener('change', e => { prefs.timestamps = e.target.checked; });

$('export').addEventListener('click', async () => {
  const range = readRange();
  if (!range) return;
  await run(pageStartExport, [{ format: prefs.format, timestamps: prefs.timestamps, ...range }]);
  renderRunning({ collected: 0, total: meeting.total });
  startPolling();
});

$('cancel').addEventListener('click', () => run(pageCancel));
$('stop-save').addEventListener('click', () => { $('stop-save').disabled = true; $('r-status').textContent = 'Saving what\'s collected…'; run(pageStopAndSave); });
['opt-from', 'opt-to'].forEach(id => $(id).addEventListener('input', () => { if (!$('range-err').hidden) readRange(); }));

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastText);
    $('copy').textContent = 'Copied';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  } catch { $('copy').textContent = 'Copy failed'; }
});

$('save-again').addEventListener('click', () => run(pageSaveAgain));

$('new-export').addEventListener('click', async () => { await run(pageClearJob); detect(); });
$('retry').addEventListener('click', detect);
$('error-retry').addEventListener('click', async () => { await run(pageClearJob); detect(); });

$('help').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }));

detect();
