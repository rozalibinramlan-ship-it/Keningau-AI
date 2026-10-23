const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY, 
    process.env.TWELVEDATA_API_KEY_2, 
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean);

async function getMarketData(symbol) {
    for (let key of TD_KEYS) {
        try {
            const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1h&outputsize=10&apikey=${key}`);
            const d = await r.json();
            if (d.values) {
                const closes = d.values.map(v => parseFloat(v.close));
                return { latestPrice: closes[0], history: [...closes].reverse() };
            }
        } catch(e){}
    }
    throw new Error("TwelveData limit atau API Key tak sah");
}

app.get('/api/generate-signal', async (req, res) => {
    try {
        const m = await getMarketData("XAU/USD");
        const prompt = `Pair XAU/USD Price ${m.latestPrice} History ${m.history.join(',')} Reply ONLY JSON: {"pair":"XAU/USD","action":"BUY","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Fresh demand"}. tp1/sl +/- 20 dollars.`;

        let text = "";

        // --- GUNA MODEL GEMINI TERBARU MELALUI v1beta ---
        try {
            // 1. Cuba gemini-2.0-flash (Model paling baru)
            const urlFlash = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
            const resFlash = await fetch(urlFlash, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            const dataFlash = await resFlash.json();
            
            if (dataFlash.error) throw new Error("Gagal 2.0-flash");
            text = dataFlash.candidates[0].content.parts[0].text;

        } catch (err1) {
            console.log("Gagal guna 2.0-flash, cuba 1.5-flash via v1beta...");
            
            // 2. Kalau 2.0-flash gagal, cuba 1.5-flash via v1beta
            const urlFallback = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
            const resFallback = await fetch(urlFallback, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            const dataFallback = await resFallback.json();

            if (dataFallback.error) {
                // Tunjuk error sebenar jika kedua-duanya gagal
                throw new Error(JSON.stringify(dataFallback.error)); 
            }
            text = dataFallback.candidates[0].content.parts[0].text;
        }

        // Bersihkan markdown dan parse JSON
        text = text.replace(/```json|```/g, '').trim();
        res.json(JSON.parse(text));

    } catch (e) {
        console.error("Ralat:", e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server berjalan di port " + PORT));