'use strict';
/* Lion AI — mobile chat client for open models.
   Auto mode routes each prompt to the best-fitting model; Compare runs several
   side by side; Council has several models answer and one synthesise a verdict. */

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('lion.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lion.' + k, JSON.stringify(v)); } catch {} }
};

const state = {
  mode: 'auto',
  effort: 'medium',
  research: false,
  models: store.get('models', []),
  history: store.get('history', []),   // [{role, content}]
  busy: null                            // AbortController while generating
};

/* ---------- settings ---------- */
function baseUrl() {
  const p = store.get('provider', 'https://openrouter.ai/api/v1');
  return (p === 'custom' ? store.get('baseUrl', '') : p).replace(/\/$/, '');
}
function headers() {
  const h = { 'Content-Type': 'application/json' };
  const key = store.get('apiKey', '');
  if (key) h.Authorization = 'Bearer ' + key;
  if (baseUrl().includes('openrouter')) { h['HTTP-Referer'] = location.origin; h['X-Title'] = 'Lion AI'; }
  return h;
}

async function loadModels() {
  const status = $('#modelStatus');
  status.textContent = 'Loading…';
  try {
    const r = await fetch(baseUrl() + '/models', { headers: headers() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = (await r.json()).data || [];
    const freeOnly = store.get('freeOnly', true) && baseUrl().includes('openrouter');
    state.models = data
      .filter(m => !freeOnly || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0))
      .filter(m => !m.architecture || (m.architecture.output_modalities || ['text']).includes('text'))
      .map(m => ({ id: m.id, name: m.name || m.id, ctx: m.context_length || 0, reasoning: (m.supported_parameters || []).includes('reasoning') }));
    store.set('models', state.models);
    status.textContent = state.models.length + ' models ready.';
  } catch (e) {
    status.textContent = 'Could not load models: ' + e.message;
  }
}

/* ---------- smart routing ---------- */
const TASKS = {
  code:     { re: /\b(code|function|bug|error|python|javascript|typescript|java|rust|sql|regex|api|compile|script|html|css|react)\b|```/i,
              prefer: ['coder', 'devstral', 'codestral', 'qwen3', 'deepseek', 'kimi', 'glm'] },
  math:     { re: /\b(prove|solve|equation|integral|derivative|probability|calculate|math|theorem|\d+\s*[\+\-\*\/\^]\s*\d+)\b/i,
              prefer: ['r1', 'qwq', 'think', 'reason', 'deepseek', 'qwen3', 'phi'] },
  research: { re: /\b(latest|news|research|sources?|compare|history of|who is|what happened|statistics|study)\b/i,
              prefer: ['deepseek', 'qwen3', 'llama-4', 'gemini', 'glm', 'kimi', 'mistral'] },
  creative: { re: /\b(story|poem|write|lyrics|essay|creative|joke|email|caption)\b/i,
              prefer: ['llama', 'mistral', 'gemma', 'deepseek-chat', 'kimi', 'hermes'] },
  general:  { re: /./, prefer: ['deepseek', 'qwen3', 'llama', 'gemma', 'mistral', 'glm', 'gpt-oss'] }
};

function classify(prompt) {
  for (const [k, t] of Object.entries(TASKS)) if (k !== 'general' && t.re.test(prompt)) return k;
  return 'general';
}

function sizeOf(id) {
  const m = id.toLowerCase().match(/(\d+(?:\.\d+)?)b\b/);
  return m ? +m[1] : (/mini|small|nano|tiny|lite/.test(id) ? 5 : 70);
}

function rankModels(task, effort) {
  const prefer = TASKS[task].prefer;
  return state.models.map(m => {
    const id = m.id.toLowerCase();
    let s = 0;
    prefer.forEach((p, i) => { if (id.includes(p)) s += (prefer.length - i) * 3; });
    const size = sizeOf(id);
    if (effort === 'low')    s += size <= 12 ? 8 : size <= 40 ? 3 : -2;
    if (effort === 'medium') s += size >= 14 && size <= 120 ? 4 : 0;
    if (effort === 'high')   s += (m.reasoning ? 8 : 0) + Math.min(size, 700) / 60;
    if (/vision|vl\b|embed|guard|tts|audio/.test(id)) s -= 20;
    return { m, s };
  }).sort((a, b) => b.s - a.s).map(x => x.m);
}

function pickDiverse(list, n) {
  const out = [], fams = new Set();
  for (const m of list) {
    const fam = m.id.split('/')[0];
    if (!fams.has(fam)) { out.push(m); fams.add(fam); }
    if (out.length === n) return out;
  }
  for (const m of list) { if (out.length === n) break; if (!out.includes(m)) out.push(m); }
  return out;
}

/* ---------- research agent (free: Wikipedia) ---------- */
async function research(prompt) {
  const q = prompt.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 8).join(' ') || prompt;
  const api = 'https://en.wikipedia.org/w/api.php?origin=*&format=json&action=query&generator=search&gsrlimit=4&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=1200&gsrsearch=';
  try {
    const r = await fetch(api + encodeURIComponent(q));
    const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
    return pages.map((p, i) => ({ n: i + 1, title: p.title, url: p.fullurl, text: p.extract || '' }));
  } catch { return []; }
}

/* ---------- streaming chat call ---------- */
const EFFORT_SYS = {
  low: 'Be brief and direct.',
  medium: 'Answer clearly and thoroughly, without padding.',
  high: 'Think step by step, check your reasoning carefully, consider edge cases, then give a complete, well-structured answer.'
};

async function chat(model, messages, onDelta, signal) {
  const body = { model: model.id, messages, stream: true };
  if (model.reasoning) body.reasoning = { effort: state.effort };
  const r = await fetch(baseUrl() + '/chat/completions', { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', think = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        if (j.error) throw new Error(j.error.message || 'Model error');
        const delta = j.choices?.[0]?.delta || {};
        if (delta.reasoning) think += delta.reasoning;
        if (delta.reasoning_content) think += delta.reasoning_content;
        if (delta.content) text += delta.content;
        onDelta(text, think);
      } catch (e) { if (e.message && !(e instanceof SyntaxError)) throw e; }
    }
  }
  // Some models put their thinking inline in <think> tags.
  const m = text.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (m) { think += m[1]; text = text.slice(m[0].length).trim(); onDelta(text, think); }
  return text;
}

/* ---------- rendering ---------- */
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function md(src) {
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, l, c) => { blocks.push(c); return '\u0000' + (blocks.length - 1) + '\u0000'; });
  let html = esc(src)
    .replace(/^#{1,3} (.*)$/gm, '<h3>$1</h3>').replace(/^#{4,6} (.*)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup>[$1]</sup>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[^"'>=\w])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,;:!?)\]'"*])/g,
      (_, pre, url) => `${pre}<a href="${url.startsWith('www.') ? 'https://' + url : url}" target="_blank" rel="noopener">${url}</a>`);
  html = html.split(/\n{2,}/).map(p => {
    if (/^\s*([-*]|\d+\.) /m.test(p) && p.split('\n').every(l => /^\s*([-*]|\d+\.) /.test(l) || !l.trim())) {
      const tag = /^\s*\d+\./.test(p) ? 'ol' : 'ul';
      return `<${tag}>` + p.split('\n').filter(l => l.trim()).map(l => '<li>' + l.replace(/^\s*([-*]|\d+\.) /, '') + '</li>').join('') + `</${tag}>`;
    }
    return /^<h[34]>|^\u0000/.test(p.trim()) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => '<pre><code>' + esc(blocks[i]) + '</code></pre>');
}

const chatEl = $('#chat');
const nearBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
const scroll = (force) => { if (force || nearBottom()) chatEl.scrollTop = chatEl.scrollHeight; };

function addUser(text) {
  $('#empty')?.remove();
  const d = document.createElement('div');
  d.className = 'msg user'; d.textContent = text;
  chatEl.append(d); scroll(true);
}

function aiBox(parent, tags) {
  const d = document.createElement('div');
  d.className = 'msg ai';
  d.innerHTML = `<div class="meta">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div><details class="think" hidden><summary>Thinking…</summary><div></div></details><div class="body cursor"></div>`;
  parent.append(d);
  const body = d.querySelector('.body'), th = d.querySelector('.think');
  return {
    el: d,
    update(text, think) {
      if (think) { th.hidden = false; th.querySelector('div').textContent = think; }
      body.innerHTML = md(text); scroll();
    },
    done(sources) {
      body.classList.remove('cursor');
      th.querySelector('summary').textContent = 'Reasoning';
      if (sources?.length) {
        const s = document.createElement('div'); s.className = 'sources';
        s.innerHTML = 'Sources: ' + sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">[${x.n}] ${esc(x.title)}</a>`).join(' · ');
        d.append(s);
      }
    },
    fail(e) { body.classList.remove('cursor'); body.innerHTML = `<span class="err">${esc(e.name === 'AbortError' ? 'Stopped.' : e.message)}</span>`; }
  };
}

/* ---------- main flow ---------- */
async function send(prompt) {
  if (!state.models.length) { openSettings(); $('#modelStatus').textContent = 'Add a key and load models first.'; return; }
  addUser(prompt);
  const ctrl = new AbortController(); state.busy = ctrl; setBusy(true);
  const task = classify(prompt);
  const ranked = rankModels(task, state.effort);

  let sources = [];
  let sys = 'You are Lion AI, a sharp, honest assistant. Use Markdown. ' + EFFORT_SYS[state.effort];
  if (state.research) {
    sources = await research(prompt);
    if (sources.length) sys += '\n\nUse these sources where relevant and cite them as [n]:\n' + sources.map(s => `[${s.n}] ${s.title}: ${s.text}`).join('\n\n');
  }
  const messages = [{ role: 'system', content: sys }, ...state.history.slice(-12), { role: 'user', content: prompt }];
  const short = id => id.split('/').pop().replace(/:free$/, '');
  let final = '';

  try {
    if (state.mode === 'auto') {
      // Try the best match; fall back down the ranking if a free model is busy.
      for (const model of ranked.slice(0, 3)) {
        const box = aiBox(chatEl, [short(model.id), task, state.effort]);
        try { final = await chat(model, messages, box.update, ctrl.signal); box.done(sources); break; }
        catch (e) { box.fail(e); if (e.name === 'AbortError') break; }
      }
    } else {
      const picks = pickDiverse(ranked, 3);
      const wrap = document.createElement('div'); wrap.className = 'cards';
      chatEl.append(wrap);
      const answers = await Promise.all(picks.map(async model => {
        const card = document.createElement('div'); card.className = 'card'; wrap.append(card);
        const box = aiBox(card, [short(model.id)]);
        try { const t = await chat(model, messages, box.update, ctrl.signal); box.done(); return { model, t }; }
        catch (e) { box.fail(e); return null; }
      }));
      const ok = answers.filter(Boolean);
      if (state.mode === 'council' && ok.length && !ctrl.signal.aborted) {
        const judge = ranked.find(m => m.reasoning) || ranked[0];
        const box = aiBox(chatEl, ['council verdict', short(judge.id)]);
        box.el.classList.add('verdict');
        const brief = ok.map((a, i) => `### Answer ${i + 1} (${short(a.model.id)})\n${a.t}`).join('\n\n');
        final = await chat(judge, [
          { role: 'system', content: sys + '\nYou chair a council of AI models. Compare their answers, keep what is correct, fix errors, resolve disagreements, and write the single best final answer. Briefly note where they disagreed.' },
          { role: 'user', content: `Question: ${prompt}\n\n${brief}` }
        ], box.update, ctrl.signal);
        box.done(sources);
      } else {
        final = ok[0]?.t || '';
      }
    }
  } catch (e) {
    aiBox(chatEl, ['error']).fail(e);
  }

  if (final) {
    state.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: final });
    store.set('history', state.history.slice(-40));
  }
  state.busy = null; setBusy(false);
}

function setBusy(b) { $('#send').classList.toggle('stop', b); $('#send').setAttribute('aria-label', b ? 'Stop' : 'Send'); }

/* ---------- UI wiring ---------- */
const input = $('#input');
const grow = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
input.addEventListener('input', grow);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  if (state.busy) { state.busy.abort(); return; }
  const p = input.value.trim(); if (!p) return;
  input.value = ''; grow(); send(p);
});

function seg(id, key) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    state[key] = b.dataset.v; store.set(key, state[key]);
  });
  const saved = store.get(key, null);
  if (saved) { state[key] = saved; $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === saved)); }
}
seg('#mode', 'mode'); seg('#effort', 'effort');

$('#research').addEventListener('click', e => {
  state.research = !state.research; e.currentTarget.setAttribute('aria-pressed', state.research);
});
document.querySelectorAll('.suggest button').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.p; grow(); input.focus(); }));

$('#newChat').addEventListener('click', () => {
  state.busy?.abort(); state.history = []; store.set('history', []);
  location.reload();
});

function openSettings() { $('#sheet').hidden = false; }
$('#openSettings').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', () => { $('#sheet').hidden = true; });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });

const prov = $('#provider');
prov.value = store.get('provider', 'https://openrouter.ai/api/v1');
$('#customWrap').hidden = prov.value !== 'custom';
$('#baseUrl').value = store.get('baseUrl', '');
$('#apiKey').value = store.get('apiKey', '');
$('#freeOnly').checked = store.get('freeOnly', true);
prov.addEventListener('change', () => { store.set('provider', prov.value); $('#customWrap').hidden = prov.value !== 'custom'; });
$('#baseUrl').addEventListener('change', e => store.set('baseUrl', e.target.value.trim()));
$('#apiKey').addEventListener('change', e => store.set('apiKey', e.target.value.trim()));
$('#freeOnly').addEventListener('change', e => store.set('freeOnly', e.target.checked));
$('#loadModels').addEventListener('click', loadModels);
if (state.models.length) $('#modelStatus').textContent = state.models.length + ' models ready.';

// Restore the last conversation.
for (let i = 0; i < state.history.length; i += 2) {
  addUser(state.history[i].content);
  const b = aiBox(chatEl, ['history']); b.update(state.history[i + 1]?.content || ''); b.done();
}

// Open every web link outside the app. Installed web apps on Android can ignore
// plain target=_blank taps, so open it explicitly and fall back to navigating.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a || !/^https?:/i.test(a.getAttribute('href'))) return;
  e.preventDefault(); e.stopPropagation();
  const w = window.open(a.href, '_blank', 'noopener');
  if (!w) location.href = a.href;
}, true);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
