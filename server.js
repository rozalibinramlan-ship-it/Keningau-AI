const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. API Keys TwelveData
const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY, 
    process.env.TWELVEDATA_API_KEY_2, 
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// 2. Mapping Sesi Pasaran
function getActiveSession() {
    const now = new Date();
    const mytHour = parseInt(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur", hour: '2-digit', hour12: false }));
    
    if (mytHour >= 7 && mytHour < 15) return { name: "ASIA", tp: 8, sl: 10 };
    if (mytHour >= 15 && mytHour < 20) return { name: "LONDON", tp: 15, sl: 12 };
    if (mytHour >= 20 || mytHour < 2) return { name: "NEW YORK", tp: 25, sl: 18 };
    return { name: "OVERLAP", tp: 20, sl: 15 };
}

// Fungsi Ambil Data TwelveData
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

// Endpoint API
app.get('/api/generate-signal', async (req, res) => {
    try {
        const m = await getMarketData("XAU/USD");
        const session = getActiveSession(); 
        
        const prompt = `
        Pair: XAU/USD. Current Price: ${m.latestPrice}. 
        History: ${m.history.join(', ')}.
        Session: ${session.name}.
        Reply ONLY JSON: {"pair":"XAU/USD","action":"BUY" or "SELL","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Short reason"}
        If BUY: tp1 roughly Entry+${session.tp}, sl roughly Entry-${session.sl}.
        If SELL: tp1 roughly Entry-${session.tp}, sl roughly Entry+${session.sl}.
        `;

        let text = "";
        let success = false;
        let lastError = "";

        // =====================================================================
        // LANGKAH 1: TANYA GOOGLE MODEL APA YANG ADA
        // =====================================================================
        console.log("Menyemak senarai model yang tersedia untuk API Key anda...");
        const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
        const listRes = await fetch(listUrl);
        const listData = await listRes.json();

        if (listData.error) {
            throw new Error("Gagal dapatkan senarai model: " + listData.error.message);
        }

        // Cari model yang menyokong "generateContent"
        const availableModels = listData.models
            .filter(mod => mod.supportedGenerationMethods.includes("generateContent"))
            .map(mod => mod.name.replace("models/", "")); // Buang perkataan 'models/'

        console.log("Model yang dijumpai:", availableModels);

        // Ambil model pertama yang ada (biasanya Gemini 1.5 Flash atau Pro)
        if (availableModels.length === 0) {
            throw new Error("Tiada model langsung yang boleh digunakan oleh API Key ini.");
        }

        // =====================================================================
        // LANGKAH 2: GUNA MODEL YANG DIJUMPAI
        // =====================================================================
        // Cuba 3 model pertama dari senarai yang sah
        const modelsToTry = availableModels.slice(0, 3); 

        for (let modelName of modelsToTry) {
            try {
                console.log(`Cuba guna model yang SAH: ${modelName}...`);
                
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                const data = await response.json();

                if (data.error) {
                    lastError = data.error.message;
                    continue; 
                }

                text = data.candidates[0].content.parts[0].text;
                success = true;
                console.log(`Berjaya guna model: ${modelName}`);
                break; 

            } catch (err) {
                lastError = err.message;
            }
        }

        if (!success) {
            throw new Error("Gagal guna semua model yang dijumpai. Ralat: " + lastError);
        }
        
        text = text.replace(/```json|```/g, '').trim();
        const signalData = JSON.parse(text);
        signalData.session_active = session.name; 
        
        res.json(signalData);

    } catch (e) {
        console.error(e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server berjalan di port " + PORT));