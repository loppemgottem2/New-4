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
  busy: null,                           // AbortController while generating
  pinned: store.get('pinned', null),    // model id the user chose to always use in Auto
  active: new Set(),                    // model ids generating right now
  open: null,                           // model id expanded in the Models tab
  health: store.get('health', {}),      // id -> { ok, ms, err, t } from tests and real use
  testing: null,                        // { done, total } while "Test all models" runs
  testingIds: new Set(),
  verify: store.get('verify', false),
  testNote: ''
};
const HEALTH_TTL = 6 * 3600e3;          // trust a test result for 6 hours
function health(id) { const h = state.health[id]; return h && Date.now() - h.t < HEALTH_TTL ? h : null; }
function setHealth(id, ok, extra = {}) { state.health[id] = { ok, t: Date.now(), ...extra }; store.set('health', state.health); }

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
      .map(m => ({
        id: m.id, name: m.name || m.id, ctx: m.context_length || 0,
        reasoning: (m.supported_parameters || []).includes('reasoning'),
        tools: (m.supported_parameters || []).includes('tools'),
        free: !m.pricing || (+m.pricing.prompt === 0 && +m.pricing.completion === 0),
        vision: ((m.architecture || {}).input_modalities || []).includes('image'),
        desc: (m.description || '').replace(/\s+/g, ' ').slice(0, 280)
      }));
    store.set('models', state.models);
    status.textContent = state.models.length + ' models ready.';
    refreshModels();
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
    const h = health(m.id);
    if (h) s += h.ok ? 6 : -100;
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

function friendly(msg) {
  if (/provider returned error|upstream|overloaded|unavailable|502|503|timeout/i.test(msg)) return 'This free model is down or overloaded right now.';
  if (/rate.?limit|429|too many/i.test(msg)) return 'Free limit reached for this model. Wait a minute or try another.';
  if (/data policy|no endpoints/i.test(msg)) return 'Blocked by your OpenRouter privacy settings: allow free models at openrouter.ai/settings/privacy.';
  if (/401|unauthor|invalid.*key|no auth/i.test(msg)) return 'Your API key was rejected. Check it in Settings.';
  if (/402|credits|payment/i.test(msg)) return 'This model needs paid credits.';
  if (/not a valid model|404|not found/i.test(msg)) return 'This model no longer exists. Reload models in Settings.';
  return msg;
}

async function chat(model, messages, onDelta, signal) {
  state.active.add(model.id); refreshModels();
  try { const t = await chatStream(model, messages, onDelta, signal); setHealth(model.id, true); return t; }
  catch (e) { if (e.name !== 'AbortError') setHealth(model.id, false, { err: friendly(e.message) }); throw e; }
  finally { state.active.delete(model.id); refreshModels(); }
}

async function chatStream(model, messages, onDelta, signal) {
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
    .replace(/(^|[^"'>=\w\/.@])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,;:!?)\]'"*]|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|co|edu|gov|me|info|tv|gg|xyz|uk|de|fr|jp|ca|au|us)\b(?:\/[^\s<]*[^\s<.,;:!?)\]'"*])?)/gi,
      (_, pre, url) => `${pre}<a href="${/^https?:/i.test(url) ? url : 'https://' + url}" target="_blank" rel="noopener">${url}</a>`);
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
    fail(e) { body.classList.remove('cursor'); body.innerHTML = `<span class="err">${md(e.name === 'AbortError' ? 'Stopped.' : friendly(e.message))}</span>`; }
  };
}

/* ---------- which models a prompt will use ---------- */
function plan(prompt) {
  const task = classify(prompt || '');
  let ranked = rankModels(task, state.effort);
  const pinned = state.models.find(m => m.id === state.pinned);
  if (pinned) ranked = [pinned, ...ranked.filter(m => m !== pinned)];
  const answer = state.mode === 'auto' ? ranked.slice(0, 5) : pickDiverse(ranked, 3);
  const judge = state.mode === 'council' ? (rankModels(task, state.effort).find(m => m.reasoning) || ranked[0]) : null;
  // Checkers: other companies' models that double-check the final answer.
  const writer = judge || answer[0];
  const checkers = state.verify && state.mode !== 'compare'
    ? pickDiverse(ranked.filter(m => m !== writer && m.id.split('/')[0] !== writer?.id.split('/')[0]), 3) : [];
  return { task, answer, judge, checkers };
}

const REVIEW_SYS = 'You are a strict expert reviewer. Check the answer below for factual errors, wrong code or math, missing important parts, and misleading advice. ' +
  'If it is correct and complete, reply with exactly: APPROVED. Otherwise reply "ISSUES:" followed by a short list of concrete problems and how to fix each. Do not rewrite the whole answer.';

async function verify(prompt, final, writer, checkers, sys, sources, signal) {
  const pool = checkers.filter(m => m.id !== writer.id).slice(0, 2);
  if (!pool.length) return final;
  const head = document.createElement('div'); head.className = 'note'; head.textContent = 'Double-checking with ' + pool.map(nice).join(' and ') + '…';
  const wrap = document.createElement('div'); wrap.className = 'cards checks';
  chatEl.append(head, wrap); scroll(true);
  const reviews = (await Promise.all(pool.map(async m => {
    const card = document.createElement('div'); card.className = 'card'; wrap.append(card);
    const box = aiBox(card, ['checker', nice(m)]);
    try {
      const t = await chat(m, [{ role: 'system', content: REVIEW_SYS }, { role: 'user', content: `Question:\n${prompt}\n\nAnswer to check:\n${final}` }], box.update, signal);
      box.done(); return { m, t };
    } catch (e) { box.fail(e); return null; }
  }))).filter(Boolean);
  if (!reviews.length) { head.textContent = 'Could not double-check: the checker models are unavailable right now.'; return final; }
  const issues = reviews.filter(r => !/^\W*APPROVED\W*$/i.test(r.t.trim()) && !/^\W*APPROVED\b/i.test(r.t.trim()));
  if (!issues.length) {
    head.className = 'verified'; head.textContent = '✓ Verified by ' + reviews.map(r => nice(r.m)).join(' and ');
    return final;
  }
  head.textContent = `${issues.length} of ${reviews.length} checkers found problems. Fixing them…`;
  const box = aiBox(chatEl, ['corrected answer', nice(writer)]); box.el.classList.add('verdict');
  try {
    const fixed = await chat(writer, [
      { role: 'system', content: sys + '\nOther AI models reviewed your answer. Fix every valid problem they found, ignore criticism that is wrong, and write the complete corrected answer. Start with one short italic line saying what was fixed.' },
      { role: 'user', content: `Question: ${prompt}\n\nYour answer:\n${final}\n\nReviews:\n${issues.map(r => `- ${nice(r.m)}: ${r.t}`).join('\n')}` }
    ], box.update, signal);
    box.done(sources); head.textContent = 'Checked by ' + reviews.map(r => nice(r.m)).join(' and ') + ', problems fixed below.';
    return fixed || final;
  } catch (e) { box.fail(e); return final; }
}

/* ---------- main flow ---------- */
async function send(prompt) {
  if (!state.models.length) { openSettings(); $('#modelStatus').textContent = 'Add a key and load models first.'; return; }
  addUser(prompt);
  const ctrl = new AbortController(); state.busy = ctrl; setBusy(true);
  closeModels();
  state.prompt = prompt;
  const { task, answer, judge, checkers } = plan(prompt);
  let writer = null;

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
      for (const model of answer) {
        const box = aiBox(chatEl, [short(model.id), task, state.effort]);
        try { final = await chat(model, messages, box.update, ctrl.signal); box.done(sources); writer = model; break; }
        catch (e) {
          if (e.name === 'AbortError' || model === answer[answer.length - 1]) { box.fail(e); break; }
          box.el.className = 'note'; box.el.textContent = `${nice(model)} was unavailable, switching to the next model…`;
        }
      }
    } else {
      const picks = answer;
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
        const box = aiBox(chatEl, ['council verdict', short(judge.id)]);
        box.el.classList.add('verdict');
        const brief = ok.map((a, i) => `### Answer ${i + 1} (${short(a.model.id)})\n${a.t}`).join('\n\n');
        final = await chat(judge, [
          { role: 'system', content: sys + '\nYou chair a council of AI models. Compare their answers, keep what is correct, fix errors, resolve disagreements, and write the single best final answer. Briefly note where they disagreed.' },
          { role: 'user', content: `Question: ${prompt}\n\n${brief}` }
        ], box.update, ctrl.signal);
        box.done(sources); writer = judge;
      } else {
        final = ok[0]?.t || '';
      }
    }
    if (final && writer && checkers.length && !ctrl.signal.aborted) final = await verify(prompt, final, writer, checkers, sys, sources, ctrl.signal);
  } catch (e) {
    aiBox(chatEl, ['error']).fail(e);
  }

  if (final) {
    state.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: final });
    store.set('history', state.history.slice(-40));
  }
  state.busy = null; setBusy(false); refreshModels();
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
$('#mode').addEventListener('click', () => refreshModels());
$('#effort').addEventListener('click', () => refreshModels());
input.addEventListener('input', () => refreshModels());

$('#verify').setAttribute('aria-pressed', state.verify);
$('#verify').addEventListener('click', e => {
  state.verify = !state.verify; store.set('verify', state.verify); e.currentTarget.setAttribute('aria-pressed', state.verify); refreshModels();
});
$('#research').addEventListener('click', e => {
  state.research = !state.research; e.currentTarget.setAttribute('aria-pressed', state.research); refreshModels();
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

/* ---------- Models tab ---------- */
const COMPANIES = {
  'deepseek': 'DeepSeek', 'qwen': 'Alibaba Qwen', 'meta-llama': 'Meta', 'google': 'Google', 'mistralai': 'Mistral AI',
  'microsoft': 'Microsoft', 'nvidia': 'NVIDIA', 'openai': 'OpenAI', 'moonshotai': 'Moonshot AI', 'z-ai': 'Zhipu AI',
  'thudm': 'Zhipu AI', 'nousresearch': 'Nous Research', 'cognitivecomputations': 'Cognitive Computations',
  'tngtech': 'TNG Technology', 'minimax': 'MiniMax', 'baidu': 'Baidu', 'tencent': 'Tencent', 'x-ai': 'xAI',
  'anthropic': 'Anthropic', 'cohere': 'Cohere', 'amazon': 'Amazon', 'ibm-granite': 'IBM', 'arcee-ai': 'Arcee AI',
  'agentica-org': 'Agentica', 'shisa-ai': 'Shisa AI', 'moonshot': 'Moonshot AI', 'liquid': 'Liquid AI',
  'allenai': 'Allen AI', 'inclusionai': 'inclusionAI', 'meituan': 'Meituan', 'stepfun-ai': 'StepFun',
  'bytedance': 'ByteDance', 'rekaai': 'Reka', 'openrouter': 'OpenRouter', 'mistral': 'Mistral AI'
};
const TASK_NAME = { code: 'coding', math: 'math & logic', research: 'research', creative: 'writing', general: 'general' };
const MODE_INFO = {
  auto: 'One model answers. If it is busy, the next one takes over automatically.',
  compare: 'Three models from different companies answer at the same time, shown side by side.',
  council: 'Three models answer, then a judge model checks them, fixes mistakes and writes one final answer. Four models work on your prompt together.'
};
const company = id => { const k = id.split('/')[0].toLowerCase(); return COMPANIES[k] || k.replace(/(^|[-_])(\w)/g, (_, a, c) => (a ? ' ' : '') + c.toUpperCase()); };
const nice = m => m.name.replace(/^[^:]+:\s*/, '').replace(/\s*\(free\)\s*$/i, '');
const ctxText = n => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : n || '?';
const DOMAINS = {
  deepseek: 'deepseek.com', qwen: 'qwen.ai', 'meta-llama': 'meta.com', google: 'google.com', mistralai: 'mistral.ai', mistral: 'mistral.ai',
  microsoft: 'microsoft.com', nvidia: 'nvidia.com', openai: 'openai.com', moonshotai: 'moonshot.ai', 'z-ai': 'z.ai', thudm: 'z.ai',
  nousresearch: 'nousresearch.com', tngtech: 'tngtech.com', minimax: 'minimax.io', baidu: 'baidu.com', tencent: 'tencent.com',
  'x-ai': 'x.ai', anthropic: 'anthropic.com', cohere: 'cohere.com', amazon: 'amazon.com', 'ibm-granite': 'ibm.com', 'arcee-ai': 'arcee.ai',
  liquid: 'liquid.ai', allenai: 'allenai.org', bytedance: 'bytedance.com', openrouter: 'openrouter.ai', meituan: 'meituan.com',
  'stepfun-ai': 'stepfun.com', inclusionai: 'antgroup.com', cognitivecomputations: 'erichartford.com', rekaai: 'reka.ai', 'shisa-ai': 'shisa.ai'
};
const logoLetters = id => { const k = id.split('/')[0].replace(/[^A-Za-z0-9]/g, ''); return esc((k[0] || '?').toUpperCase() + (k[1] || '')); };
// Company icon from its website; the letters show if it cannot load.
const logo = id => {
  const d = DOMAINS[id.split('/')[0].toLowerCase()];
  return `<span class="logo" aria-hidden="true">${logoLetters(id)}${d ? `<img src="https://www.google.com/s2/favicons?domain=${d}&sz=64" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
};

function roles() {
  const p = plan(state.busy ? state.prompt : input.value), r = new Map();
  p.answer.forEach((m, i) => r.set(m.id, state.mode === 'auto' ? (i ? 'Backup ' + i : 'Answers') : 'Member ' + (i + 1)));
  if (p.judge) r.set(p.judge.id, r.has(p.judge.id) ? r.get(p.judge.id) + ' + Judge' : 'Judge');
  p.checkers.slice(0, 2).forEach(m => r.set(m.id, r.has(m.id) ? r.get(m.id) + ' + Checker' : 'Checker'));
  return { p, r };
}

function modelRow(m, role) {
  const live = state.active.has(m.id), pinned = state.pinned === m.id, open = state.open === m.id;
  const badges = [m.free !== false ? 'Free' : 'Paid', m.reasoning && 'Reasoning', m.tools && 'Tools', m.vision && 'Vision', ctxText(m.ctx) + ' context']
    .filter(Boolean).map(b => `<span class="tag">${b}</span>`).join('');
  const h = health(m.id);
  const status = live ? '<span class="st live">In use</span>' : pinned ? '<span class="st on">Pinned</span>' : role ? `<span class="st">${esc(role)}</span>` : '';
  const testing = state.testingIds.has(m.id);
  const kind = testing ? 'testing' : h ? (h.ok ? 'ok' : 'bad') : 'none';
  const dot = `<span class="dot ${kind}"></span>`;
  const statusText = testing ? 'testing…' : h ? (h.ok ? 'works' + (h.ms ? ' · ' + (h.ms / 1000).toFixed(1) + 's' : '') : 'not working') : 'not tested yet';
  return `<div class="mrow${open ? ' open' : ''}${live ? ' is-live' : ''}" data-id="${esc(m.id)}">
    <button class="mtop">${logo(m.id)}<span class="mname"><b>${dot}${esc(nice(m))}</b><small>${esc(company(m.id))} · ${statusText}</small></span>${status}</button>
    <div class="mmore">
      <div class="tags">${badges}</div>
      ${h && !h.ok ? `<p class="err">${esc(h.err || 'Failed last test.')}</p>` : ''}
      ${m.desc ? `<p>${esc(m.desc)}${m.desc.length >= 280 ? '…' : ''}</p>` : ''}
      <code>${esc(m.id)}</code>
      <button class="pin">${pinned ? 'Stop always using this' : 'Always use this model'}</button>
    </div>
  </div>`;
}

function refreshModels() {
  // Line under the title: what is (or will be) used.
  const line = $('#modelLine');
  if (!state.models.length) line.textContent = 'Tap to see models';
  else if (state.active.size) line.textContent = 'Working: ' + [...state.active].map(id => nice(state.models.find(m => m.id === id) || { name: id })).join(', ');
  else {
    const p = plan(input.value);
    line.textContent = state.mode === 'auto' ? (p.answer[0] ? nice(p.answer[0]) + (state.pinned ? ' · pinned' : '') + (p.checkers.length ? ' + 2 checkers' : '') : 'No model')
      : state.mode === 'compare' ? 'Compare · ' + p.answer.length + ' models' : 'Council · ' + p.answer.length + ' models + judge' + (p.checkers.length ? ' + 2 checkers' : '');
  }
  const panel = $('#models');
  if (panel.hidden) return;

  if (!state.models.length) {
    $('#plan').innerHTML = `<div class="pcard"><h3>No models loaded</h3><p class="hint">Add your free key in Settings, then tap Load models.</p><button class="primary" id="goSettings">Open Settings</button></div>`;
    $('#mList').innerHTML = ''; $('#mCount').textContent = '';
    return;
  }

  const { p, r } = roles();
  const used = [...new Set([...p.answer, ...(p.judge ? [p.judge] : []), ...p.checkers.slice(0, 2)])];
  $('#plan').innerHTML = `<div class="pcard">
    <div class="phead"><h3>For your prompt</h3><span class="tag">${state.mode[0].toUpperCase() + state.mode.slice(1)}</span></div>
    <p class="hint">${MODE_INFO[state.mode]}${p.checkers.length ? ' Then 2 checkers from other companies double-check the answer, and it is fixed if they find problems.' : state.verify && state.mode === 'compare' ? ' (Verify works in Auto and Council.)' : ''}</p>
    <p class="hint">Detected: <b>${TASK_NAME[p.task]}</b> · thinking <b>${state.effort}</b>${state.research ? ' · <b>research on</b>' : ''}${state.busy ? ' · running now' : input.value.trim() ? '' : ' (type a prompt to see it change)'}</p>
    ${used.map(m => modelRow(m, r.get(m.id))).join('')}
  </div>`;

  const hs = state.models.map(m => health(m.id)).filter(Boolean);
  const okN = hs.filter(h => h.ok).length, badN = hs.length - okN;
  const hasDeepSeek = state.models.some(m => /deepseek/i.test(m.id));
  $('#mTools').innerHTML = `
    <button class="primary" id="testAll" ${state.testing ? 'disabled' : ''}>${state.testing ? `Testing ${state.testing.done} of ${state.testing.total}…` : 'Test all models'}</button>
    <p class="hint"><b>${okN} working</b> · ${badN} not working · ${state.models.length - hs.length} not tested yet. Lion AI skips broken models automatically.</p>
    ${state.testNote ? `<p class="hint err">${esc(state.testNote)}</p>` : ''}
    <p class="hint">Each test uses one free message (free accounts get about 50 a day). Keep the app open until it finishes.</p>
    ${hasDeepSeek ? '' : '<p class="hint">No free DeepSeek model is offered right now. OpenRouter changes its free list often; reload models in Settings later to check again.</p>'}`;

  const q = $('#mSearch').value.trim().toLowerCase();
  const list = state.models.filter(m => !q || (m.id + ' ' + m.name + ' ' + company(m.id)).toLowerCase().includes(q));
  const groups = {};
  list.forEach(m => (groups[company(m.id)] ||= []).push(m));
  $('#mCount').textContent = `(${list.length})`;
  $('#mList').innerHTML = Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([c, ms]) => `<div class="group"><h4>${esc(c)} <span>${ms.length}</span></h4>${ms.map(m => modelRow(m, r.get(m.id))).join('')}</div>`).join('')
    || '<p class="hint">No models match.</p>';
}

// Returns 'ok', 'bad', 'retry' (per-minute limit) or 'daily' (daily free limit used up).
async function testModel(m) {
  const t0 = performance.now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(baseUrl() + '/chat/completions', { method: 'POST', headers: headers(), signal: ctrl.signal,
      body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'Reply with the word OK.' }], max_tokens: 16 }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const msg = j.error?.metadata?.raw || j.error?.message || 'HTTP ' + r.status;
      if (r.status === 429 || j.error?.code === 429) return /per.?day|daily|free-models-per-day/i.test(msg) ? 'daily' : 'retry';
      if (r.status === 401) return 'auth';
      throw new Error(msg);
    }
    setHealth(m.id, true, { ms: Math.round(performance.now() - t0) });
    return 'ok';
  } catch (e) {
    setHealth(m.id, false, { err: e.name === 'AbortError' ? 'Did not answer within 25 seconds.' : friendly(e.message) });
    return 'bad';
  } finally { clearTimeout(timer); }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function testAll() {
  if (state.testing) return;
  // Test untested models first, then the oldest results.
  const list = [...state.models].sort((a, b) => (health(a.id)?.t || 0) - (health(b.id)?.t || 0));
  state.testing = { done: 0, total: list.length }; state.testNote = ''; refreshModels();
  let stop = false;
  const worker = async () => {
    for (let m; !stop && (m = list.shift());) {
      state.testingIds.add(m.id); refreshModels();
      let res = await testModel(m);
      for (let tries = 0; res === 'retry' && tries < 3 && !stop; tries++) {
        state.testNote = 'Free per-minute limit reached, waiting 20 seconds…'; refreshModels();
        await wait(20000); state.testNote = '';
        res = await testModel(m);
      }
      state.testingIds.delete(m.id);
      if (res === 'daily') { stop = true; state.testNote = 'Your free daily message limit is used up, so the rest stay untested. It resets daily, or add credits on OpenRouter for a higher limit.'; }
      else if (res === 'auth') { stop = true; state.testNote = 'Your API key was rejected. Check it in Settings.'; }
      else state.testing.done++;
      refreshModels();
    }
  };
  await Promise.all([worker(), worker()]);
  state.testing = null; refreshModels();
}

function closeModels() { $('#models').hidden = true; $('#modelTab').setAttribute('aria-expanded', 'false'); }
$('#modelTab').addEventListener('click', () => {
  const open = $('#models').hidden;
  $('#models').hidden = !open; $('#modelTab').setAttribute('aria-expanded', String(open));
  if (open) { refreshModels(); $('#models').scrollTop = 0; }
});
$('#mSearch').addEventListener('input', refreshModels);
$('#models').addEventListener('click', e => {
  if (e.target.id === 'goSettings') { openSettings(); return; }
  if (e.target.closest('#testAll')) { testAll(); return; }
  const row = e.target.closest('.mrow'); if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.pin')) {
    state.pinned = state.pinned === id ? null : id; store.set('pinned', state.pinned);
  } else if (e.target.closest('.mtop')) {
    state.open = state.open === id ? null : id;
  } else return;
  refreshModels();
});
refreshModels();

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
