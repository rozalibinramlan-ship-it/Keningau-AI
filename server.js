const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

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
            const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${n}&apikey=${key}`);
            const d = await r.json();
            if (d.values) {
                const cs = d.values.map(v => ({ o: +v.open, h: +v.high, l: +v.low, c: +v.close })).reverse(); // lama -> baru
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
        pair: 'XAU/USD', action, entry: +f(entry), tp1: +f(tp), stop_loss: +f(sl), confidence,
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

function sesKey() { // sesi semasa + kunci unik (nama:tarikh mula). Overlap tiada signal
    const d = new Date(Date.now() + 8 * 3600e3), h = d.getUTCHours();
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
    ST.sigs.unshift({ ...sig, sid: ses.key, session: ses.name, tf: tf.toUpperCase(), htf: sig.htf_bias, ts: Date.now(),
        state: lim ? 'menunggu' : 'masuk', mkt: !lim, lastCheck: Date.now(), srv: true });
    ST.sigs = ST.sigs.slice(0, 30); saveST();
}
async function checkSigs() {
    const now = Date.now(), cur = sesKey();
    const act = ST.sigs.filter(s => s.state === 'menunggu' || s.state === 'masuk');
    if (!act.length) return;
    for (const s of act) {
        if (s.state === 'menunggu' && (!cur || cur.key !== s.sid)) { s.state = 'tamat'; s.res = 'SESI TAMAT'; }
        else if ((s.state === 'menunggu' && now - s.ts > 4 * 3600e3) || (s.state === 'masuk' && now - s.ts > 24 * 3600e3)) { s.state = 'tamat'; s.res = 'TAMAT MASA'; }
    }
    const live = act.filter(s => (s.state === 'menunggu' || s.state === 'masuk') && now - s.lastCheck >= 290000);
    if (live.length) { // satu panggilan sahaja untuk semua signal aktif
        const cs = await getCandles('5min', 12);
        for (const s of live) {
            const k = Math.min(cs.length, Math.ceil((now - s.lastCheck) / 300000) + 1), w = cs.slice(-k);
            s.lastCheck = now;
            applyTick(s, Math.max(...w.map(x => x.h)), Math.min(...w.map(x => x.l)));
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

module.exports = { analyze, normNews, applyTick, _t: { ST, cache, genSession, checkSigs, sesKey } };
if (require.main === module) {
    setInterval(tick, 120000); setTimeout(tick, 5000);
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log("Server berjalan di port " + PORT));
}