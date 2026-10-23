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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// 2. Fungsi Ambil Data TwelveData
async function getMarketData(symbol) {
    for (let i = 0; i < TD_KEYS.length; i++) {
        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1h&outputsize=10&apikey=${TD_KEYS[i]}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.values && data.values[0]) {
                const closes = data.values.map(v => parseFloat(v.close));
                return { 
                    latestPrice: closes[0], 
                    history: [...closes].reverse() 
                };
            }
        } catch (err) {
            console.log(`Key ${i+1} gagal`);
        }
    }
    throw new Error("Semua TwelveData Key limit / belum set di Render");
}

// 3. Endpoint API
app.get('/api/generate-signal', async (req, res) => {
    try {
        const marketData = await getMarketData("XAU/USD");

        const prompt = `
        Pair: XAU/USD, Price: ${marketData.latestPrice}, History: ${marketData.history.join(', ')}
        Give signal. Reply ONLY JSON: {"pair":"XAU/USD","action":"BUY","entry":${marketData.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Fresh demand bounce"}
        tp1/stop_loss realistic +/- 15-35 dollars from entry.
        `;

        let text = "";
        
        // --- LOGIK AUTO-FALLBACK MODEL GEMINI ---
        try {
            // 1. Cuba model terbaru yang Google syorkan (gemini-3.0-flash)
            const model = genAI.getGenerativeModel({ model: "gemini-3.0-flash" }); 
            const result = await model.generateContent(prompt);
            text = result.response.text();
        } catch (e1) {
            console.log("Gagal guna gemini-3.0-flash. Cuba fallback ke gemini-1.5-pro...", e1.message);
            try {
                // 2. Kalau gagal, cuba model 1.5-pro
                const fallbackModel1 = genAI.getGenerativeModel({ model: "gemini-1.5-pro" }); 
                const fallbackResult1 = await fallbackModel1.generateContent(prompt);
                text = fallbackResult1.response.text();
            } catch (e2) {
                console.log("Gagal guna 1.5-pro. Cuba fallback terakhir ke gemini-pro...", e2.message);
                // 3. Kalau masih gagal, cuba gemini-pro klasik
                const fallbackModel2 = genAI.getGenerativeModel({ model: "gemini-pro" }); 
                const fallbackResult2 = await fallbackModel2.generateContent(prompt);
                text = fallbackResult2.response.text();
            }
        }
        
        // Bersihkan markdown jika AI degil
        text = text.replace(/```json|```/g, '').trim();
        const signalData = JSON.parse(text);
        
        res.json(signalData);

    } catch (error) {
        console.error("Ralat Sistem:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));