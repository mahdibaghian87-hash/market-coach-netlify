// Netlify Function: serves the page at "/" and the API at "/api/*"
const env = k => globalThis.Netlify?.env?.get(k) ?? process.env[k];

const MARKETS = {
  gold:   { symbol: 'XAU/USD', name: { fa: 'طلا', en: 'Gold' } },
  brent:  { symbol: 'XBR/USD', name: { fa: 'نفت برنت', en: 'Brent oil' } },
  dow:    { symbol: 'DIA',     name: { fa: 'داو جونز (DIA)', en: 'Dow Jones (DIA)' } },
  eurusd: { symbol: 'EUR/USD', name: { fa: 'یورو/دلار', en: 'EUR/USD' } },
  gbpusd: { symbol: 'GBP/USD', name: { fa: 'پوند/دلار', en: 'GBP/USD' } },
  usdjpy: { symbol: 'USD/JPY', name: { fa: 'دلار/ین', en: 'USD/JPY' } },
};

const cache = new Map();
const inflight = new Map();
function cached(key, ttl, fn) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < ttl) return Promise.resolve(e.v);
  if (inflight.has(key)) return inflight.get(key);
  const p = fn()
    .then(v => { cache.set(key, { v, at: Date.now() }); return v; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function getCandles(symbol) {
  const u = new URL('https://api.twelvedata.com/time_series');
  u.search = new URLSearchParams({ symbol, interval: '1h', outputsize: '120', apikey: env('TWELVE_KEY') || '' });
  const j = await (await fetch(u)).json();
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'No data');
  return j.values.map(v => ({ h: +v.high, l: +v.low, c: +v.close })).reverse();
}

const sma = (a, n) => { const s = a.slice(-n); return s.reduce((x, y) => x + y, 0) / s.length; };
function rsi(cl, n = 14) {
  let g = 0, l = 0;
  for (let i = cl.length - n; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function analyze(candles) {
  const cl = candles.map(c => c.c);
  const last = cl.at(-1);
  const ref = cl.at(-25) ?? cl[0];
  const s20 = sma(cl, 20), s50 = sma(cl, 50);
  const recent = candles.slice(-20);
  const trend = last > s20 && s20 > s50 ? 'up' : last < s20 && s20 < s50 ? 'down' : 'side';
  return {
    price: last, change: ((last - ref) / ref) * 100, trend, rsi: rsi(cl),
    sma20: s20, sma50: s50,
    support: Math.min(...recent.map(c => c.l)),
    resistance: Math.max(...recent.map(c => c.h)),
  };
}
const getAnalysis = id => cached('a:' + id, 5 * 60e3, async () => analyze(await getCandles(MARKETS[id].symbol)));

async function claude(system, user, max = 500) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY') || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env('ANTHROPIC_MODEL') || 'claude-sonnet-5-5', max_tokens: max, system, messages: [{ role: 'user', content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'AI error');
  return j.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

const LANG = { fa: 'Persian (Farsi)', en: 'English' };
const SUMMARY_SYS = lang =>
  `You write short educational market commentary for beginners. Reply in ${LANG[lang]}, exactly 2 short sentences, plain text. ` +
  `Describe what the indicators show (trend, RSI zone, nearness to support/resistance). ` +
  `Never say buy or sell, never give price targets, never promise outcomes.`;
const ASK_SYS = lang =>
  `You are a patient teacher of technical analysis and risk management for beginner traders. Reply in ${LANG[lang]}, concise (under 150 words), plain text. ` +
  `Only discuss trading education, indicators, markets and risk. Politely decline other topics. ` +
  `Never give exact buy/sell signals, price targets or guarantees; if asked, explain how to evaluate a setup and stress risk management.`;

const getSummary = (id, lang) =>
  cached(`s:${id}:${lang}`, 10 * 60e3, async () => {
    const a = await getAnalysis(id);
    const data = { market: MARKETS[id].name.en, ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v])) };
    return claude(SUMMARY_SYS(lang), JSON.stringify(data), 200);
  });

const hits = new Map();
function limited(uid, max = 15, windowMs = 3600e3) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const HTML = "<!doctype html>\n<html lang=\"fa\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Market Coach</title>\n<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📈</text></svg>\">\n<style>\n:root{\n  --bg:#f6f7f9; --tx:#14171c; --hint:#667080; --card:#ffffff;\n  --btn:#9a6f1f; --btnt:#ffffff; --up:#1a9a82; --down:#d24c3f; --side:#667080;\n  --line:rgba(100,110,125,.25);\n}\n@media (prefers-color-scheme:dark){:root{\n  --bg:#14171c; --tx:#eceff3; --hint:#8a93a0; --card:#1d2229;\n  --btn:#c8963e; --btnt:#14171c; --up:#2fb59a; --down:#e5675a; --side:#9aa3b0;\n}}\n*{box-sizing:border-box;margin:0}\nhtml,body{height:100%}\nhtml{background:var(--bg)}\nbody{max-width:640px;margin:0 auto;background:var(--bg);color:var(--tx);font:16px/1.6 system-ui,-apple-system,\"Segoe UI\",Tahoma,sans-serif;display:flex;flex-direction:column}\nheader{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 6px;padding-top:calc(14px + env(safe-area-inset-top,0px))}\nh1{font-size:20px;font-weight:700}\n#lang{background:var(--card);color:var(--tx);border:1px solid var(--line);border-radius:10px;padding:6px 12px;font:inherit;font-size:14px}\nmain{flex:1;overflow-y:auto;padding:8px 16px 16px}\nnav{display:flex;border-top:1px solid var(--line);background:var(--bg);padding-bottom:env(safe-area-inset-bottom,0px)}\nnav button{flex:1;background:none;border:0;color:var(--hint);padding:12px 4px;font:inherit;font-size:14px}\nnav button.on{color:var(--btn);font-weight:700;box-shadow:inset 0 2px 0 var(--btn)}\n.row{display:flex;justify-content:space-between;align-items:center;background:var(--card);border-radius:14px;padding:14px;margin-bottom:10px;cursor:pointer}\n.row b{font-size:16px}\n.num{direction:ltr;unicode-bidi:isolate;font-variant-numeric:tabular-nums}\n.r{text-align:end}\n.up{color:var(--up)}.down{color:var(--down)}.side{color:var(--side)}\n.chip{font-size:13px;margin-top:2px}\n.back{background:none;border:0;color:var(--btn);font:inherit;padding:6px 0 10px}\n.box{background:var(--card);border-radius:14px;padding:16px;margin-bottom:12px}\n.big{font-size:32px;font-weight:700}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n.grid div{background:var(--card);border-radius:12px;padding:12px}\n.grid small{color:var(--hint);display:block;font-size:13px}\n.sum{border-inline-start:3px solid var(--btn)}\n.warn{color:var(--hint);font-size:13px;margin-top:14px}\ndetails{background:var(--card);border-radius:14px;margin-bottom:10px;padding:14px}\nsummary{font-weight:700;cursor:pointer}\ndetails p{margin-top:8px;color:var(--tx)}\n.msg{padding:10px 14px;border-radius:14px;margin-bottom:8px;max-width:88%;white-space:pre-wrap}\n.me{background:var(--btn);color:var(--btnt);margin-inline-start:auto}\n.ai{background:var(--card)}\n.ask{display:flex;gap:8px;position:sticky;bottom:0;background:var(--bg);padding-top:8px}\n.ask input{flex:1;background:var(--card);color:var(--tx);border:1px solid var(--line);border-radius:12px;padding:12px;font:inherit}\n.ask button{background:var(--btn);color:var(--btnt);border:0;border-radius:12px;padding:0 18px;font:inherit;font-weight:700}\n.row,.box,.grid div,details{border:1px solid var(--line)}\n.muted{color:var(--hint);text-align:center;padding:24px 0}\n@media (prefers-reduced-motion:no-preference){.row:active{transform:scale(.99)}}\n</style>\n</head>\n<body>\n<header><h1 id=\"title\"></h1><button id=\"lang\"></button></header>\n<main id=\"view\"></main>\n<nav id=\"nav\"></nav>\n\n<script>\nconst T = {\n  fa: {\n    title: 'مربی بازار', other: 'EN',\n    tabs: { markets: 'بازارها', learn: 'آموزش', ask: 'پرسش از هوش مصنوعی' },\n    trend: { up: 'صعودی', down: 'نزولی', side: 'خنثی' },\n    back: 'بازگشت', loading: 'در حال دریافت…', err: 'دریافت اطلاعات ممکن نشد. چند لحظه بعد دوباره امتحان کن.',\n    price: 'قیمت', rsi: 'RSI', sup: 'حمایت', res: 'مقاومت', sma20: 'میانگین ۲۰', sma50: 'میانگین ۵۰',\n    rsiZ: { hot: 'اشباع خرید', cold: 'اشباع فروش', mid: 'معمولی' },\n    note: 'نمودار ساعتی، به‌روزرسانی هر ۵ دقیقه. این محتوا آموزشی است و توصیه مالی نیست؛ ترید ریسک دارد و ممکن است کل سرمایه را از دست بدهی.',\n    ph: 'سوالت درباره تحلیل یا ریسک…', send: 'ارسال',\n    hi: 'هر سوالی درباره کندل، اندیکاتورها یا مدیریت ریسک داری بپرس.',\n    lessons: [\n      ['کندل چیست؟', 'هر کندل قیمت باز شدن، بسته شدن، بالاترین و پایین‌ترین قیمت یک بازه زمانی (مثلاً یک ساعت) را نشان می‌دهد. بدنه فاصله باز و بسته شدن است و سایه‌ها میزان نوسان را نشان می‌دهند.'],\n      ['روند', 'روند صعودی یعنی قله و کف‌های بالاتر، نزولی یعنی قله و کف‌های پایین‌تر، و خنثی یعنی حرکت در یک محدوده. در این اپ روند با میانگین متحرک ۲۰ و ۵۰ ساعته سنجیده می‌شود.'],\n      ['حمایت و مقاومت', 'حمایت سطحی است که قیمت چند بار از آن برگشته و بالا رفته؛ مقاومت سطحی است که قیمت از آن پایین آمده. شکسته شدن این سطوح می‌تواند نشانه تغییر رفتار بازار باشد.'],\n      ['RSI', 'عددی بین ۰ تا ۱۰۰ که قدرت حرکت اخیر را نشان می‌دهد. بالای ۷۰ رشد تند (اشباع خرید) و زیر ۳۰ افت تند (اشباع فروش) است. این‌ها هشدارند، نه سیگنال قطعی؛ در روند قوی RSI می‌تواند مدت‌ها بالا یا پایین بماند.'],\n      ['حد ضرر', 'سفارشی که اگر قیمت خلاف انتظارت رفت، معامله را خودکار می‌بندد. قبل از ورود تعیینش کن و از ترس جابه‌جایش نکن.'],\n      ['مدیریت سرمایه', 'در هر معامله فقط درصد کوچکی از سرمایه (مثلاً ۱ تا ۲ درصد) را در ریسک بگذار. اهرم بالا سود و ضرر را هم‌زمان بزرگ می‌کند و حساب را زود نابود می‌کند.'],\n    ],\n  },\n  en: {\n    title: 'Market Coach', other: 'فا',\n    tabs: { markets: 'Markets', learn: 'Learn', ask: 'Ask AI' },\n    trend: { up: 'Uptrend', down: 'Downtrend', side: 'Sideways' },\n    back: 'Back', loading: 'Loading…', err: 'Could not load data. Try again in a moment.',\n    price: 'Price', rsi: 'RSI', sup: 'Support', res: 'Resistance', sma20: 'SMA 20', sma50: 'SMA 50',\n    rsiZ: { hot: 'Overbought', cold: 'Oversold', mid: 'Neutral' },\n    note: 'Hourly chart, refreshed every 5 minutes. Educational content, not financial advice. Trading is risky and you can lose all your capital.',\n    ph: 'Ask about analysis or risk…', send: 'Send',\n    hi: 'Ask anything about candles, indicators or risk management.',\n    lessons: [\n      ['What is a candle?', 'A candle shows the open, close, high and low price of one time period (for example one hour). The body is the distance between open and close; the wicks show the range of movement.'],\n      ['Trend', 'An uptrend makes higher highs and higher lows, a downtrend makes lower highs and lower lows, and a sideways market moves within a range. Here the trend is judged with the 20 and 50 hour moving averages.'],\n      ['Support and resistance', 'Support is a level where price has bounced up several times; resistance is a level where it has turned down. A break through either can signal a change in behavior.'],\n      ['RSI', 'A number from 0 to 100 that measures recent momentum. Above 70 is a sharp rise (overbought), below 30 a sharp fall (oversold). These are warnings, not certain signals; in a strong trend RSI can stay extreme for a long time.'],\n      ['Stop loss', 'An order that closes your trade automatically if price moves against you. Set it before you enter, and do not move it out of fear.'],\n      ['Risk management', 'Risk only a small share of your capital per trade (for example 1 to 2 percent). High leverage magnifies gains and losses together and can wipe out an account quickly.'],\n    ],\n  },\n};\n\nlet lang = 'fa', tab = 'markets', open = null, chat = [];\ntry { lang = localStorage.getItem('lang') || ((navigator.language || '').startsWith('fa') ? 'fa' : 'en'); } catch {}\nconst t = () => T[lang];\nconst $ = id => document.getElementById(id);\nconst esc = s => String(s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });\nconst dec = p => (p < 10 ? 4 : 2);\n\nasync function api(path, opts = {}) {\n  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json' } });\n  const j = await r.json();\n  if (!r.ok) throw new Error(j.error || 'Error');\n  return j;\n}\n\nfunction shell() {\n  document.documentElement.lang = lang;\n  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';\n  $('title').textContent = t().title;\n  $('lang').textContent = t().other;\n  $('nav').innerHTML = Object.entries(t().tabs).map(([k, v]) => `<button data-t=\"${k}\" class=\"${k === tab ? 'on' : ''}\">${v}</button>`).join('');\n}\n\nasync function render() {\n  shell();\n  if (tab === 'markets') return open ? detail(open) : markets();\n  if (tab === 'learn') return learn();\n  return ask();\n}\n\nasync function markets() {\n  const v = $('view');\n  v.innerHTML = `<p class=\"muted\">${t().loading}</p>`;\n  try {\n    const list = await api('/api/markets?lang=' + lang);\n    if (tab !== 'markets' || open) return;\n    v.innerHTML = list.map(m => m.error\n      ? `<div class=\"row\"><b>${esc(m.name)}</b><span class=\"muted\" style=\"padding:0\">—</span></div>`\n      : `<div class=\"row\" data-id=\"${m.id}\">\n           <div><b>${esc(m.name)}</b><div class=\"chip ${m.trend}\">${t().trend[m.trend]}</div></div>\n           <div class=\"r\"><div class=\"num\">${fmt(m.price, dec(m.price))}</div>\n           <div class=\"chip num ${m.change >= 0 ? 'up' : 'down'}\">${m.change >= 0 ? '+' : ''}${fmt(m.change)}%</div></div>\n         </div>`).join('') + `<p class=\"warn\">${t().note}</p>`;\n  } catch (e) { v.innerHTML = `<p class=\"muted\">${t().err}</p>`; }\n}\n\nasync function detail(id) {\n  const v = $('view');\n  v.innerHTML = `<button class=\"back\" id=\"back\">${t().back}</button><p class=\"muted\">${t().loading}</p>`;\n  $('back').onclick = () => { open = null; render(); };\n  try {\n    const a = await api(`/api/analysis/${id}?lang=${lang}`);\n    if (open !== id || tab !== 'markets') return;\n    const d = dec(a.price);\n    const z = a.rsi >= 70 ? 'hot' : a.rsi <= 30 ? 'cold' : 'mid';\n    v.innerHTML = `<button class=\"back\" id=\"back\">${t().back}</button>\n      <div class=\"box\"><div>${esc(a.name)}</div>\n        <div class=\"big num\">${fmt(a.price, d)}</div>\n        <div class=\"${a.trend}\"><b>${t().trend[a.trend]}</b>\n        <span class=\"num ${a.change >= 0 ? 'up' : 'down'}\"> ${a.change >= 0 ? '+' : ''}${fmt(a.change)}%</span></div></div>\n      ${a.summary ? `<div class=\"box sum\">${esc(a.summary)}</div>` : ''}\n      <div class=\"grid\">\n        <div><small>${t().rsi}</small><b class=\"num\">${fmt(a.rsi, 1)}</b> · ${t().rsiZ[z]}</div>\n        <div><small>${t().sup}</small><b class=\"num\">${fmt(a.support, d)}</b></div>\n        <div><small>${t().res}</small><b class=\"num\">${fmt(a.resistance, d)}</b></div>\n        <div><small>${t().sma20}</small><b class=\"num\">${fmt(a.sma20, d)}</b></div>\n        <div><small>${t().sma50}</small><b class=\"num\">${fmt(a.sma50, d)}</b></div>\n      </div>\n      <p class=\"warn\">${t().note}</p>`;\n    $('back').onclick = () => { open = null; render(); };\n  } catch (e) {\n    v.innerHTML = `<button class=\"back\" id=\"back\">${t().back}</button><p class=\"muted\">${esc(e.message || t().err)}</p>`;\n    $('back').onclick = () => { open = null; render(); };\n  }\n}\n\nfunction learn() {\n  $('view').innerHTML = t().lessons.map(([h, p]) => `<details><summary>${esc(h)}</summary><p>${esc(p)}</p></details>`).join('') +\n    `<p class=\"warn\">${t().note}</p>`;\n}\n\nfunction ask() {\n  const v = $('view');\n  const msgs = chat.length ? chat : [{ r: 'ai', x: t().hi }];\n  v.innerHTML = msgs.map(m => `<div class=\"msg ${m.r === 'me' ? 'me' : 'ai'}\">${esc(m.x)}</div>`).join('') +\n    `<div class=\"ask\"><input id=\"q\" maxlength=\"600\" placeholder=\"${t().ph}\"><button id=\"go\">${t().send}</button></div>`;\n  const send = async () => {\n    const q = $('q').value.trim();\n    if (!q) return;\n    chat.push({ r: 'me', x: q }, { r: 'ai', x: t().loading });\n    ask();\n    try {\n      const { answer } = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question: q, lang }) });\n      chat[chat.length - 1].x = answer;\n    } catch (e) { chat[chat.length - 1].x = e.message || t().err; }\n    if (tab === 'ask') { ask(); v.scrollTop = v.scrollHeight; }\n  };\n  $('go').onclick = send;\n  $('q').onkeydown = e => { if (e.key === 'Enter') send(); };\n  v.scrollTop = v.scrollHeight;\n}\n\n$('nav').onclick = e => {\n  const k = e.target.dataset.t;\n  if (k) { tab = k; open = null; render(); }\n};\n$('view').onclick = e => {\n  const row = e.target.closest('[data-id]');\n  if (row) { open = row.dataset.id; render(); }\n};\n$('lang').onclick = () => {\n  lang = lang === 'fa' ? 'en' : 'fa';\n  try { localStorage.setItem('lang', lang); } catch {}\n  render();\n};\n\nrender();\n</script>\n</body>\n</html>\n";

export default async (req, context) => {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) {
    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  const route = url.pathname.slice(4);
  const lang = url.searchParams.get('lang') === 'fa' ? 'fa' : 'en';
  try {
    if (req.method === 'GET' && route === '/markets') {
      const out = await Promise.all(Object.keys(MARKETS).map(async id => {
        try {
          const a = await getAnalysis(id);
          return { id, name: MARKETS[id].name[lang], price: a.price, change: a.change, trend: a.trend };
        } catch { return { id, name: MARKETS[id].name[lang], error: true }; }
      }));
      return json(out);
    }
    const m = route.match(/^\/analysis\/([a-z0-9]+)$/);
    if (req.method === 'GET' && m) {
      const id = m[1];
      if (!MARKETS[id]) return json({ error: 'Unknown market' }, 404);
      const a = await getAnalysis(id);
      let summary = null;
      try { summary = await getSummary(id, lang); } catch (e) { console.error('summary', e.message); }
      return json({ id, name: MARKETS[id].name[lang], ...a, summary });
    }
    if (req.method === 'POST' && route === '/ask') {
      const body = await req.json().catch(() => ({}));
      const q = String(body.question || '').slice(0, 600).trim();
      if (!q) return json({ error: 'Empty question' }, 400);
      const uid = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'anon';
      if (limited(uid)) return json({ error: 'Too many questions. Try again later.' }, 429);
      return json({ answer: await claude(ASK_SYS(body.lang === 'fa' ? 'fa' : 'en'), q, 500) });
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 502);
  }
};

export const config = { path: ['/', '/api/*'] };
