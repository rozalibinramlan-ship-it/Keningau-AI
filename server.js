const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json());

// 1. Ambil API Keys dari Render
const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY, 
    process.env.TWELVEDATA_API_KEY_2, 
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 2. Ambil Data TwelveData
async function getMarketData(symbol) {
    for (let key of TD_KEYS) {
        try {
            const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1h&outputsize=10&apikey=${key}`);
            const d = await r.json();
            if (d.values) {
                const closes = d.values.map(v => parseFloat(v.close));
                return { 
                    latestPrice: closes[0], 
                    history: [...closes].reverse() 
                };
            }
        } catch(e){}
    }
    throw new Error("TwelveData limit atau API Key tak sah");
}

// 3. Endpoint API
app.get('/api/generate-signal', async (req, res) => {
    try {
        const m = await getMarketData("XAU/USD");
        const prompt = `Pair XAU/USD Price ${m.latestPrice} History ${m.history.join(',')} Reply ONLY JSON: {"pair":"XAU/USD","action":"BUY","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Fresh demand"}. tp1/sl +/- 20 dollars.`;

        // Paksa guna gemini-1.5-flash melalui API v1beta
        const model = genAI.getGenerativeModel(
            { model: "gemini-1.5-flash" },
            { apiVersion: "v1beta" } 
        );

        const result = await model.generateContent(prompt);
        let text = result.response.text();
        
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