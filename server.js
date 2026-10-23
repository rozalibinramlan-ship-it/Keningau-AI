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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

function getActiveSession() {
    const now = new Date();
    const mytHour = parseInt(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur", hour: '2-digit', hour12: false }));
    if (mytHour >= 7 && mytHour < 15) return { name: "ASIA", tp: 8, sl: 10 };
    if (mytHour >= 15 && mytHour < 20) return { name: "LONDON", tp: 15, sl: 12 };
    if (mytHour >= 20 || mytHour < 2) return { name: "NEW YORK", tp: 25, sl: 18 };
    return { name: "OVERLAP", tp: 20, sl: 15 };
}

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
        const session = getActiveSession(); 
        
        const prompt = `
        Pair: XAU/USD. Price: ${m.latestPrice}. History: ${m.history.join(', ')}. Session: ${session.name}.
        Reply ONLY JSON: {"pair":"XAU/USD","action":"BUY" or "SELL","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Short reason"}
        If BUY: tp1 roughly Entry+${session.tp}, sl roughly Entry-${session.sl}.
        If SELL: tp1 roughly Entry-${session.tp}, sl roughly Entry+${session.sl}.
        `;

        let text = "";
        let success = false;
        let lastError = "";

        // Cuba guna v1 (bukan v1beta) dan nama model rasmi
        const modelsToTry = ["gemini-1.5-flash-latest", "gemini-1.5-flash", "gemini-pro"];

        for (let modelName of modelsToTry) {
            try {
                console.log(`Cuba guna model: ${modelName}...`);
                
                const url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }]
                        // Tiada generationConfig untuk elak isu modaliti
                    })
                });

                const data = await response.json();

                if (!data.error) {
                    text = data.candidates[0].content.parts[0].text;
                    success = true;
                    console.log(`Berjaya guna model: ${modelName}`);
                    break; 
                } else {
                    lastError = data.error.message;
                    console.log(`Model ${modelName} gagal: ${lastError}`);
                }

            } catch (err) {
                lastError = err.message;
            }
        }

        if (!success) {
            throw new Error("Gagal. Ralat: " + lastError);
        }
        
        // Bersihkan markdown dan cari JSON
        text = text.replace(/```json|```/g, '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            text = jsonMatch[0];
        }

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