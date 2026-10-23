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

// 2. Senarai API Keys Gemini (Fallback System)
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2
].filter(Boolean);

// 3. Mapping Sesi Pasaran (Masa Malaysia - MYT)
function getActiveSession() {
    const now = new Date();
    const mytHour = parseInt(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur", hour: '2-digit', hour12: false }));
    
    if (mytHour >= 7 && mytHour < 15) {
        return { name: "ASIA", tp: 8, sl: 10, desc: "Volatility rendah, sesuai untuk TP/SL kecil." };
    } else if (mytHour >= 15 && mytHour < 20) {
        return { name: "LONDON", tp: 15, sl: 12, desc: "Volatility sederhana, breakout sering berlaku." };
    } else if (mytHour >= 20 || mytHour < 2) {
        return { name: "NEW YORK", tp: 25, sl: 18, desc: "Volatility tinggi, pergerakan dolar besar." };
    } else {
        return { name: "OVERLAP / LATE NY", tp: 20, sl: 15, desc: "Pergerakan bercampur." };
    }
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
        Recent History (Old to New): ${m.history.join(', ')}.
        Current Market Session: ${session.name} (${session.desc}).
        
        Analyze the trend. Reply ONLY JSON format:
        {"pair":"XAU/USD","action":"BUY" or "SELL","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Short reason here"}
        
        RULES:
        - If action is BUY: tp1 must be roughly (Entry + ${session.tp}), stop_loss roughly (Entry - ${session.sl}).
        - If action is SELL: tp1 must be roughly (Entry - ${session.tp}), stop_loss roughly (Entry + ${session.sl}).
        `;

        let text = "";
        let success = false;
        let lastError = "";

        const GEMINI_MODELS = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro"];

        // --- GELUNG UNTUK API KEY ---
        for (let apiKey of GEMINI_KEYS) {
            if (success) break; // Berhenti jika dah berjaya
            
            // --- GELUNG UNTUK MODEL ---
            for (let modelName of GEMINI_MODELS) {
                try {
                    console.log(`Cuba guna model: ${modelName} (Key: ...${apiKey.slice(-4)})...`);
                    
                    const url = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${apiKey}`;
                    
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: {
                                responseMimeType: "application/json"
                            }
                        })
                    });

                    const data = await response.json();

                    if (data.error) {
                        console.log(`Model ${modelName} gagal: ${data.error.message}`);
                        lastError = data.error.message;
                        
                        // Jika ralat adalah kerana Quota/Limit API Key, kita terus tukar ke API Key seterusnya
                        if (data.error.message.includes("Quota") || data.error.message.includes("limit") || data.error.message.includes("exhausted")) {
                            console.log("API Key ini dah limit. Tukar ke Key seterusnya...");
                            break; // Keluar dari gelung model, masuk ke gelung API Key seterusnya
                        }
                        continue; // Jika ralat model (cth: 404), cuba model lain dengan key yang sama
                    }

                    text = data.candidates[0].content.parts[0].text;
                    success = true;
                    console.log(`Berjaya guna model: ${modelName}`);
                    break; 

                } catch (err) {
                    console.log(`Ralat rangkaian: ${err.message}`);
                    lastError = err.message;
                }
            }
        }

        if (!success) {
            throw new Error("Semua kombinasi API Key dan Model Gemini gagal. Ralat terakhir: " + lastError);
        }
        
        text = text.replace(/```json|```/g, '').trim();
        const signalData = JSON.parse(text);
        signalData.session_active = session.name; 
        
        res.json(signalData);

    } catch (e) {
        console.error("Ralat Sistem:", e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server berjalan di port " + PORT));