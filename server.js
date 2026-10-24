const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- Telegram (TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di environment Render) ---------- */
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function sendTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return { ok: false, error: 'TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diset' };
    try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
        });
        const d = await r.json();
        if (!d.ok) { console.log('Telegram gagal:', d.description); return { ok: false, error: d.description }; }
        return { ok: true };
    } catch (e) { console.log('Gagal hantar Telegram:', e.message); return { ok: false, error: e.message }; }
}
function notifyState(s, prev) { // mesej bila signal berubah keadaan
    if (s.state === prev) return;
    const info = `${s.session} · ${s.action} XAU/USD ${s.tf || ''}\nEntry ${s.entry} · SL ${s.stop_loss} · TP ${s.tp1}`;
    let head = null;
    if (s.state === 'masuk') head = '📥 <b>LIMIT TERISI</b>';
    else if (s.state === 'tp') head = `✅ <b>TP KENA</b> +${s.pips} pips`;
    else if (s.state === 'sl') head = `🛑 <b>SL KENA</b> ${s.pips} pips`;
    else if (s.state === 'lepas') head = '⚠️ <b>ENTRY LEPAS</b> harga sudah ke TP tanpa isi limit. Jangan kejar.';
    else if (s.state === 'tamat') head = `⏹ <b>${esc(s.res || 'TAMAT')}</b>`;
    if (head) sendTelegram(head + '\n' + esc(info));
}

const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY,
    process.env.TWELVEDATA_API_KEY_2,
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean);

// timeframe utama -> interval TwelveData, dan timeframe atas untuk bias
const TF = { m5: { i: "5min", h: "1h" }, m15: { i: "15min", h: "1h" }, h1: { i: "1h", h: "4h" }, h4: { i: "4h", h: "1day" } };
const SESSION_RR = { "ASIA": 1, "LONDON": 1.5, "NEW YORK": 2, "OVERLAP": 1.5 };

const NAMES = ["ASIA", "LONDON", "NEW YORK", "OVERLAP"];
function parseRR(q) { // ?rr=1,1.5,2,1.5 ikut susunan NAMES
    const m = { ...SESSION_RR };
    if (q) String(q).split(',').forEach((v, i) => { const x = parseFloat(v); if (NAMES[i] && x >= 0.5 && x <= 5) m[NAMES[i]] = x; });
    return m;
}
function getActiveSession(map) {
    const mytHour = parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur", hour: '2-digit', hour12: false }));
    let name = "OVERLAP";
    if (mytHour >= 7 && mytHour < 15) name = "ASIA";
    else if (mytHour >= 15 && mytHour < 20) name = "LONDON";
    else if (mytHour >= 20 || mytHour < 2) name = "NEW YORK";
    return { name, rr: map[name], map };
}

/* ---------- Data ---------- */
const cache = {};
async function getCandles(interval, n) {
    const ck = interval + ':' + n;
    const c = cache[ck];
    if (c && Date.now() - c.t < 60000) return c.d; // cache 60s, jimat kuota
    for (const key of TD_KEYS) {
        try {
            const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${n}&timezone=UTC&apikey=${key}`);
            const d = await r.json();
            if (d.values) {
                const cs = d.values.map(v => { const dt = String(v.datetime); return { t: Date.parse(dt.length > 10 ? dt.replace(' ', 'T') + 'Z' : dt + 'T00:00:00Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close }; }).reverse(); // lama -> baru
                cache[ck] = { t: Date.now(), d: cs };
                return cs;
            }
        } catch (e) {}
    }
    throw new Error("TwelveData limit atau API Key tak sah");
}

/* ---------- Indikator ---------- */
const ema = (a, p) => { const k = 2 / (p + 1); let e = a[0]; return a.map((v, i) => i ? (e = v * k + e * (1 - k)) : e); };
function rsi(c, p = 14) {
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d >= 0 ? g += d : l -= d; }
    g /= p; l /= p;
    for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(cs, p = 14) {
    const tr = cs.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - cs[i].c), Math.abs(x.l - cs[i].c)));
    let a = tr.slice(0, p).reduce((s, v) => s + v, 0) / p;
    for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
    return a;
}
function macdHist(c) {
    const a = ema(c, 12), b = ema(c, 26), m = a.map((v, i) => v - b[i]), s = ema(m, 9);
    return m[m.length - 1] - s[s.length - 1];
}
function swings(cs, k = 3) {
    const highs = [], lows = [];
    for (let i = k; i < cs.length - k; i++) {
        const w = cs.slice(i - k, i + k + 1);
        if (cs[i].h === Math.max(...w.map(x => x.h))) highs.push({ i, p: cs[i].h });
        if (cs[i].l === Math.min(...w.map(x => x.l))) lows.push({ i, p: cs[i].l });
    }
    return { highs, lows };
}
function levels(sw, A) { // kluster level SNR
    const all = [...sw.highs, ...sw.lows].map(x => x.p).sort((a, b) => a - b), cl = [];
    for (const p of all) {
        const g = cl[cl.length - 1];
        if (g && p - g.max <= 0.5 * A) { g.max = p; g.sum += p; g.n++; } else cl.push({ max: p, sum: p, n: 1 });
    }
    return cl.map(g => ({ p: g.sum / g.n, n: g.n }));
}
function zonesSND(cs, A) { // zon supply/demand dari candle impuls
    const z = [];
    for (let i = Math.max(1, cs.length - 120); i < cs.length - 1; i++) {
        const body = cs[i].c - cs[i].o;
        if (Math.abs(body) >= 1.5 * A) z.push({ t: body > 0 ? 'demand' : 'supply', lo: cs[i - 1].l, hi: cs[i - 1].h, i });
    }
    return z.filter(q => !cs.slice(q.i + 1).some(x => q.t === 'demand' ? x.c < q.lo : x.c > q.hi)); // buang zon yang sudah pecah
}
const zdist = (z, price) => price > z.hi ? price - z.hi : price < z.lo ? z.lo - price : 0;

/* ---------- Enjin analisis ---------- */
function analyze(cs, hcs, session) {
    const n = cs.length, c = cs.map(x => x.c), price = c[n - 1], A = atr(cs), R = rsi(c);
    const f = x => x.toFixed(2);
    const E = []; // {n, v (+1/-1/0), note}

    const e200 = n >= 200 ? ema(c, 200)[n - 1] : null;
    const sw = swings(cs), lv = levels(sw, A);
    const sup = lv.filter(x => x.p <= price && x.n >= 2).sort((a, b) => b.p - a.p)[0];
    const res = lv.filter(x => x.p > price && x.n >= 2).sort((a, b) => a.p - b.p)[0];
    const ds = sup ? price - sup.p : 1e9, dr = res ? res.p - price : 1e9;
    if (Math.min(ds, dr) <= 0.6 * A) E.push(ds <= dr ? { n: 'SNR', v: 1, note: 'Dekat support ' + f(sup.p) } : { n: 'SNR', v: -1, note: 'Dekat resistance ' + f(res.p) });
    else E.push({ n: 'SNR', v: 0, note: 'Tiada level dekat' });

    const H = sw.highs.slice(-2), L = sw.lows.slice(-2);
    let smc = { n: 'SMC', v: 0, note: 'Struktur bercampur' };
    if (H.length === 2 && L.length === 2) {
        if (H[1].p > H[0].p && L[1].p > L[0].p) smc = { n: 'SMC', v: 1, note: 'HH + HL (naik)' };
        else if (H[1].p < H[0].p && L[1].p < L[0].p) smc = { n: 'SMC', v: -1, note: 'LH + LL (turun)' };
    }
    E.push(smc);

    E.push(e200 === null ? { n: 'EMA200', v: 0, note: 'Data tak cukup' } : { n: 'EMA200', v: price > e200 ? 1 : -1, note: (price > e200 ? 'Atas ' : 'Bawah ') + f(e200) });

    if (n >= 80) {
        const mid = (len, i) => { const s = cs.slice(i - len + 1, i + 1); return (Math.max(...s.map(x => x.h)) + Math.min(...s.map(x => x.l))) / 2; };
        const tk = mid(9, n - 1), kj = mid(26, n - 1), ci = n - 27;
        const top = Math.max((mid(9, ci) + mid(26, ci)) / 2, mid(52, ci)), bot = Math.min((mid(9, ci) + mid(26, ci)) / 2, mid(52, ci));
        if (price > top && tk > kj) E.push({ n: 'ICHIMOKU', v: 1, note: 'Atas awan, TK > KJ' });
        else if (price < bot && tk < kj) E.push({ n: 'ICHIMOKU', v: -1, note: 'Bawah awan, TK < KJ' });
        else E.push({ n: 'ICHIMOKU', v: 0, note: 'Dalam awan / bercampur' });
    } else E.push({ n: 'ICHIMOKU', v: 0, note: 'Data tak cukup' });

    const seg = cs.slice(-100), HI = Math.max(...seg.map(x => x.h)), LO = Math.min(...seg.map(x => x.l));
    const up = seg.findIndex(x => x.l === LO) < seg.findIndex(x => x.h === HI), ret = (up ? HI - price : price - LO) / (HI - LO || 1);
    E.push(ret >= 0.382 && ret <= 0.65 ? { n: 'FIBONACCI', v: up ? 1 : -1, note: 'Retrace ' + Math.round(ret * 100) + '%' } : { n: 'FIBONACCI', v: 0, note: 'Luar zon 38-65%' });

    const zs = zonesSND(cs, A), near = zs.map(z => ({ z, d: zdist(z, price) })).sort((a, b) => a.d - b.d)[0];
    E.push(near && near.d <= 0.6 * A ? { n: 'SND', v: near.z.t === 'demand' ? 1 : -1, note: (near.z.t === 'demand' ? 'Zon demand ' : 'Zon supply ') + f(near.z.lo) + '-' + f(near.z.hi) } : { n: 'SND', v: 0, note: 'Jauh dari zon' });

    const mh = macdHist(c);
    E.push({ n: 'MACD', v: mh > 0 ? 1 : -1, note: 'Histogram ' + (mh > 0 ? '+' : '') + mh.toFixed(2) });
    const mv = price - c[n - 11];
    E.push(Math.abs(mv) >= 0.5 * A ? { n: 'MOMENTUM', v: mv > 0 ? 1 : -1, note: 'RSI ' + R.toFixed(0) } : { n: 'MOMENTUM', v: 0, note: 'Lemah, RSI ' + R.toFixed(0) });

    // bias timeframe atas
    const hc = hcs.map(x => x.c), hp = hc[hc.length - 1];
    const hb = hp > ema(hc, 50)[hc.length - 1] ? 1 : -1;

    // arah
    const sum = E.reduce((s, e) => s + e.v, 0);
    const dir = sum >= 1 ? 1 : sum <= -1 ? -1 : hb;
    const agree = E.filter(e => e.v === dir).length, opp = E.filter(e => e.v === -dir).length;

    // zon entry
    const zt = dir === 1 ? 'demand' : 'supply';
    const zone = zs.filter(q => q.t === zt && (dir === 1 ? q.hi <= price + 0.2 * A : q.lo >= price - 0.2 * A))
        .sort((a, b) => zdist(a, price) - zdist(b, price))[0];
    const entry = zone ? (dir === 1 ? Math.min(price, zone.hi) : Math.max(price, zone.lo)) : price;
    let slDist = zone ? Math.abs(entry - (dir === 1 ? zone.lo - 0.25 * A : zone.hi + 0.25 * A)) : 1.2 * A;
    slDist = Math.min(2 * A, Math.max(0.8 * A, slDist));
    const sl = entry - dir * slDist, tp = entry + dir * slDist * session.rr;

    // Entry lain ikut kaedah (selain sesi). TP guna RR sesi semasa
    const sd1 = Math.min(2 * A, Math.max(0.8 * A, A));
    const mk = (type, label, e, d) => ({ type, label, entry: +f(e), sl: +f(e - dir * d), tp: +f(e + dir * d * session.rr),
        dist: Math.round(Math.abs(price - e) * 10), near: Math.abs(price - e) <= 0.5 * A });
    const entries = [mk('MARKET', 'Harga semasa', price, sd1)];
    if (zone) entries.push(mk('SND', 'Zon ' + zt, entry, slDist));
    const lvl = dir === 1 ? sup : res;
    if (lvl) entries.push(mk('SNR', dir === 1 ? 'Support' : 'Resistance', lvl.p, sd1));
    if (up === (dir === 1)) [0.5, 0.618].forEach(r => {
        const e = up ? HI - r * (HI - LO) : LO + r * (HI - LO);
        if (dir === 1 ? e <= price + 0.1 * A : e >= price - 0.1 * A) entries.push(mk('FIB', 'Fib ' + (r === 0.5 ? '50' : '61.8') + '%', e, sd1));
    });
    entries.sort((a, b) => a.dist - b.dist);

    const checks = [
        { t: 'Harga dekat zon entry', ok: Math.abs(price - entry) <= 0.5 * A },
        { t: 'Bias ' + (hb === 1 ? 'naik' : 'turun') + ' timeframe atas sejajar', ok: hb === dir },
        { t: 'Majoriti enjin setuju (' + agree + '/' + E.length + ')', ok: agree >= 4 && agree > opp },
        { t: 'Struktur SMC tidak melawan', ok: smc.v !== -dir }
    ];
    const fails = checks.filter(k => !k.ok).length;
    const confidence = Math.max(30, Math.min(95, Math.round(40 + 60 * agree / E.length - 8 * fails)));
    const action = dir === 1 ? 'BUY' : 'SELL';
    // TP untuk setiap sesi: entry dan SL sama, TP ikut risk:reward sesi
    const mapping = NAMES.map(name => ({ name, rr: session.map[name], tp: +f(entry + dir * slDist * session.map[name]) }));
    return {
        pair: 'XAU/USD', action, agree, opp, total: E.length, entry: +f(entry), tp1: +f(tp), stop_loss: +f(sl), confidence,
        status: fails === 0 ? 'SIAP' : 'TUNGGU', price: +f(price), atr: +f(A), htf_bias: hb === 1 ? 'bull' : 'bear',
        rr: session.rr, mapping, entries, engines: E, checks, zone: zone ? { t: zone.t, lo: +f(zone.lo), hi: +f(zone.hi) } : null,
        reason: `${agree}/${E.length} enjin setuju ${action}. Bias timeframe atas ${hb === 1 ? 'naik' : 'turun'}. ` +
            (zone ? `Zon ${zt} ${f(zone.lo)}-${f(zone.hi)}.` : 'Tiada zon jelas, entry harga semasa.') + (fails ? ' Belum semua syarat lepas, tunggu.' : '')
    };
}

// Papar halaman app di alamat utama (index.html mesti sebelah server.js)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ---------- Signal sesi automatik (server jana sendiri, UptimeRobot kekalkan server hidup) ---------- */
const STATE_FILE = path.join(os.tmpdir(), 'keningau_state.json');
let ST = { cfg: { tf: 'm15', rr: { ...SESSION_RR }, auto: true }, sigs: [], tries: {} };
try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); ST = { ...ST, ...j, cfg: { ...ST.cfg, ...(j.cfg || {}) } }; } catch (e) {}
const saveST = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(ST)); } catch (e) {} };

function sesKey(now = Date.now()) { // sesi semasa + kunci unik (nama:tarikh mula). Overlap tiada signal
    const d = new Date(now + 8 * 3600e3), h = d.getUTCHours();
    let name = null;
    if (h >= 7 && h < 15) name = "ASIA"; else if (h >= 15 && h < 20) name = "LONDON"; else if (h >= 20 || h < 2) name = "NEW YORK";
    if (!name) return null;
    return { name, key: name + ':' + new Date(d.getTime() - (h < 2 ? 864e5 : 0)).toISOString().slice(0, 10) };
}
function applyTick(s, hi, lo) { // sama seperti logik di app
    const buy = s.action === 'BUY', pp = x => Math.round(Math.abs(x - s.entry) * 10);
    if (s.state === 'menunggu') {
        if (buy ? lo <= s.entry : hi >= s.entry) s.state = 'masuk';
        else if (buy ? hi >= s.tp1 : lo <= s.tp1) { s.state = 'lepas'; s.res = 'ENTRY LEPAS'; return; }
    }
    if (s.state === 'masuk') {
        const tp = buy ? hi >= s.tp1 : lo <= s.tp1, sl = buy ? lo <= s.stop_loss : hi >= s.stop_loss;
        if (sl) { s.state = 'sl'; s.res = 'SL KENA'; s.pips = -pp(s.stop_loss); }   // TP dan SL dalam tempoh sama: kira SL
        else if (tp) { s.state = 'tp'; s.res = 'TP KENA'; s.pips = pp(s.tp1); }
    }
}
let nextTry = 0, ticking = false;
async function genSession() {
    const ses = sesKey();
    if (!ses || ST.cfg.auto === false || ST.sigs.some(x => x.sid === ses.key)) return;
    if ((ST.tries[ses.key] || 0) >= 3 || Date.now() < nextTry) return;
    ST.tries[ses.key] = (ST.tries[ses.key] || 0) + 1; nextTry = Date.now() + 300000; saveST();
    const tf = TF[ST.cfg.tf] ? ST.cfg.tf : 'm15', map = { ...SESSION_RR, ...ST.cfg.rr };
    const [cs, hcs] = await Promise.all([getCandles(TF[tf].i, 300), getCandles(TF[tf].h, 120)]);
    const sig = analyze(cs, hcs, { name: ses.name, rr: map[ses.name], map });
    const lim = Math.abs(sig.price - sig.entry) > 0.05;
    
    // --- TAMBAHAN TELEGRAM (HANTAR SIGNAL BARU) ---
    sendTelegram(`🔥 <b>KENINGAU AI SIGNAL</b> 🔥\n` +
        `📌 XAU/USD · <b>${ses.name}</b> · ${tf.toUpperCase()}\n` +
        `📈 <b>${sig.action}${lim ? ' LIMIT' : ''}</b> · ${sig.agree}/${sig.total} enjin sehala · ${sig.status === 'SIAP' ? 'Siap entry' : 'Tunggu syarat'}\n` +
        `🎯 Entry: <b>${sig.entry}</b>${lim ? ` (harga semasa ${sig.price})` : ''}\n` +
        `🛑 SL: <b>${sig.stop_loss}</b>\n` +
        `✅ TP: <b>${sig.tp1}</b> (RR 1:${sig.rr})\n` +
        `📝 <i>${esc(sig.reason)}</i>`);
    // ------------------------------------------------

    ST.sigs.unshift({ ...sig, sid: ses.key, session: ses.name, tf: tf.toUpperCase(), htf: sig.htf_bias, ts: Date.now(),
        state: lim ? 'menunggu' : 'masuk', mkt: !lim, lastCheck: Date.now(), srv: true });
    ST.sigs = ST.sigs.slice(0, 30); saveST();
}
async function checkSigs() {
    const now = Date.now(), cur = sesKey();
    const act = ST.sigs.filter(s => s.state === 'menunggu' || s.state === 'masuk');
    if (!act.length) return;
    for (const s of act) {
        const prev = s.state;
        if (s.state === 'menunggu' && (!cur || cur.key !== s.sid)) { s.state = 'tamat'; s.res = 'SESI TAMAT'; }
        else if ((s.state === 'menunggu' && now - s.ts > 4 * 3600e3) || (s.state === 'masuk' && now - s.ts > 24 * 3600e3)) { s.state = 'tamat'; s.res = 'TAMAT MASA'; }
        notifyState(s, prev);
    }
    const live = act.filter(s => (s.state === 'menunggu' || s.state === 'masuk') && now - s.lastCheck >= 290000);
    if (live.length) { // satu panggilan sahaja untuk semua signal aktif
        const cs = await getCandles('5min', 12);
        for (const s of live) {
            const k = Math.min(cs.length, Math.ceil((now - s.lastCheck) / 300000) + 1), w = cs.slice(-k);
            s.lastCheck = now;
            const prev = s.state;
            applyTick(s, Math.max(...w.map(x => x.h)), Math.min(...w.map(x => x.l)));
            notifyState(s, prev);
        }
    }
    saveST();
}
async function tick() {
    if (ticking) return; ticking = true;
    try { await genSession(); await checkSigs(); } catch (e) { console.log('tick:', e.message); } finally { ticking = false; }
}
app.get('/api/signals', (req, res) => { tick(); res.json({ signals: ST.sigs, session: (sesKey() || {}).name || 'OVERLAP', cfg: ST.cfg }); });
app.post('/api/config', (req, res) => { // simpan setting dari app (tf, RR, auto)
    const b = req.body || {};
    if (TF[b.tf]) ST.cfg.tf = b.tf;
    if (b.rr && typeof b.rr === 'object') NAMES.forEach(n => { const v = parseFloat(b.rr[n]); if (v >= 0.5 && v <= 5) ST.cfg.rr[n] = v; });
    if (typeof b.auto === 'boolean') ST.cfg.auto = b.auto;
    saveST(); res.json({ cfg: ST.cfg });
});

/* ---------- Backtest: satu signal setiap sesi pada data sejarah ---------- */
const DUR = { '5min': 300e3, '15min': 900e3, '1h': 3600e3, '4h': 14400e3, '1day': 864e5 };
function simulate(cs, i, sig, key) {
    const buy = sig.action === 'BUY', pp = x => Math.round(Math.abs(x - sig.entry) * 10);
    let state = Math.abs(sig.price - sig.entry) > 0.05 ? 'menunggu' : 'masuk';
    for (let j = i + 1; j < cs.length; j++) {
        const c = cs[j], age = c.t - cs[i].t;
        if (state === 'menunggu') {
            const kk = sesKey(c.t);
            if (!kk || kk.key !== key || age > 4 * 3600e3) return { r: 'tamat', pips: 0 };       // limit tak terisi sehingga sesi habis
            if (buy ? c.l <= sig.entry : c.h >= sig.entry) state = 'masuk';
            else if (buy ? c.h >= sig.tp1 : c.l <= sig.tp1) return { r: 'lepas', pips: 0 };    // harga lari ke TP tanpa isi
            else continue;
        }
        const tp = buy ? c.h >= sig.tp1 : c.l <= sig.tp1, sl = buy ? c.l <= sig.stop_loss : c.h >= sig.stop_loss;
        if (sl) return { r: 'sl', pips: -pp(sig.stop_loss) };    // TP dan SL dalam satu candle: kira SL
        if (tp) return { r: 'tp', pips: pp(sig.tp1) };
        if (age > 24 * 3600e3) return { r: 'timeout', pips: Math.round((buy ? c.c - sig.entry : sig.entry - c.c) * 10) };
    }
    return { r: 'terbuka', pips: 0 };
}
function stats(list) {
    const tr = list.filter(x => x.r === 'tp' || x.r === 'sl' || x.r === 'timeout');
    const w = tr.filter(x => x.pips > 0), l = tr.filter(x => x.pips <= 0);
    const gp = w.reduce((a, x) => a + x.pips, 0), gl = -l.reduce((a, x) => a + x.pips, 0);
    let eq = 0, pk = 0, dd = 0; const curve = [];
    tr.forEach(x => { eq += x.pips; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); curve.push(Math.round(eq)); });
    const st = Math.max(1, Math.ceil(curve.length / 150));
    return { signals: list.length, trades: tr.length, unfilled: list.filter(x => x.r === 'tamat' || x.r === 'lepas').length, wins: w.length, losses: l.length,
        winRate: tr.length ? +(100 * w.length / tr.length).toFixed(1) : 0, net: Math.round(eq), pf: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? null : 0),
        maxDD: Math.round(dd), curve: curve.filter((_, i) => i % st === 0 || i === curve.length - 1) };
}
const BT = {};
async function runBacktest(tf) {
    const key = tf + JSON.stringify(ST.cfg.rr);
    if (BT[key] && Date.now() - BT[key].t < 6 * 3600e3) return BT[key].d;
    const mI = TF[tf].i, hI = TF[tf].h;
    const [cs, hcs] = await Promise.all([getCandles(mI, 5000), getCandles(hI, 5000)]);
    if (cs.length < 400) throw new Error('Data sejarah tak cukup untuk backtest');
    const map = { ...SESSION_RR, ...ST.cfg.rr }, dur = DUR[mI], hd = DUR[hI], out = [];
    let last = (sesKey(cs[249].t) || {}).key, hp = 0;
    for (let i = 250; i < cs.length - 2; i++) {
        const k = sesKey(cs[i].t);
        if (!k || k.key === last) continue;
        last = k.key;
        while (hp < hcs.length && hcs[hp].t + hd <= cs[i].t + dur) hp++;          // hanya candle timeframe atas yang sudah tutup
        if (hp < 55) continue;
        const sig = analyze(cs.slice(Math.max(0, i - 299), i + 1), hcs.slice(Math.max(0, hp - 120), hp), { name: k.name, rr: map[k.name], map });
        out.push({ ts: cs[i].t, session: k.name, status: sig.status, ...simulate(cs, i, sig, k.key) });
    }
    const d = { tf, from: cs[250].t, to: cs[cs.length - 1].t, all: stats(out), siap: stats(out.filter(x => x.status === 'SIAP')),
        bySession: Object.fromEntries(['ASIA', 'LONDON', 'NEW YORK'].map(n => [n, stats(out.filter(x => x.session === n))])) };
    BT[key] = { t: Date.now(), d };
    return d;
}
app.get('/api/backtest', async (req, res) => {
    try { res.json(await runBacktest(TF[req.query.tf] ? req.query.tf : 'm15')); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/candles', async (req, res) => { // 100 candle terakhir untuk carta (kongsi cache dengan analisis)
    try {
        const tf = TF[req.query.tf] ? req.query.tf : 'm15', cs = await getCandles(TF[tf].i, 300);
        res.json({ tf, candles: cs.slice(-100) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Berita ekonomi (Forex Factory, minggu ini) ---------- */
const NEWS_URLS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json'];
let newsCache = { t: 0, d: null };
function normNews(list) {
    const ok = { high: 1, medium: 1, low: 1 };
    return list.map(e => ({ title: e.title, cur: e.country, ts: new Date(e.date).getTime(), impact: String(e.impact).toLowerCase(), fc: e.forecast || '', pv: e.previous || '' }))
        .filter(e => ok[e.impact] && !isNaN(e.ts)).sort((a, b) => a.ts - b.ts);
}
app.get('/api/news', async (req, res) => {
    try {
        if (newsCache.d && Date.now() - newsCache.t < 30 * 60000) return res.json({ events: newsCache.d }); // cache 30 minit
        let list = null, err = '';
        for (const u of NEWS_URLS) {
            try {
                const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 KeningauAI' } });
                if (!r.ok) { err = 'HTTP ' + r.status; continue; }
                list = await r.json(); break;
            } catch (e) { err = e.message; }
        }
        if (!Array.isArray(list)) {
            if (newsCache.d) return res.json({ events: newsCache.d, stale: true }); // guna data lama kalau sumber sekat
            throw new Error('Berita tak dapat dimuat (' + err + ')');
        }
        newsCache = { t: Date.now(), d: normNews(list) };
        res.json({ events: newsCache.d });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Harga semasa dan high/low 12 candle M5 terakhir, untuk semak entry/TP/SL signal aktif
app.get('/api/price', async (req, res) => {
    try {
        const cs = await getCandles('5min', 12);
        res.json({ price: cs[cs.length - 1].c, candles: cs.slice(-12).map(x => ({ h: x.h, l: x.l })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/telegram-test', async (req, res) => { // semak sambungan Telegram
    const r = await sendTelegram('✅ <b>Keningau AI</b> berjaya disambung ke Telegram.');
    res.status(r.ok ? 200 : 500).json(r);
});

app.get('/health', (req, res) => { tick(); res.status(200).send('OK'); }); // UptimeRobot ping juga mencetus semakan

app.get('/api/generate-signal', async (req, res) => {
    try {
        const tf = TF[req.query.tf] ? req.query.tf : 'm15';
        const [cs, hcs] = await Promise.all([getCandles(TF[tf].i, 300), getCandles(TF[tf].h, 120)]);
        if (cs.length < 60) throw new Error("Data candle tak cukup");
        const session = getActiveSession(parseRR(req.query.rr));
        const sig = analyze(cs, hcs, session);
        sig.tf = tf.toUpperCase();
        sig.session_active = session.name;
        res.json(sig);
    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = { analyze, normNews, applyTick, _t: { ST, cache, genSession, checkSigs, sesKey, runBacktest, sendTelegram } };
if (require.main === module) {
    setInterval(tick, 120000); setTimeout(tick, 5000);
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log("Server berjalan di port " + PORT));
}