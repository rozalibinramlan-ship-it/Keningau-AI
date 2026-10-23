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

// 2. Mapping Model AI Groq (Fallback System)
const GROQ_MODELS = [
    "llama-3.3-70b-versatile", 
    "llama-3.1-8b-instant",    
    "llama3-8b-8192",          
    "mixtral-8x7b-32768"       
];

// =====================================================================
// 3. MAPPING SESI PASARAN (Waktu Malaysia - MYT)
// =====================================================================
function getActiveSession() {
    const now = new Date();
    const mytHour = parseInt(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur", hour: '2-digit', hour12: false }));
    
    if (mytHour >= 7 && mytHour < 15) {
        return { name: "ASIA", tp: 8, sl: 10, desc: "Volatility rendah, TP/SL kecil." };
    } else if (mytHour >= 15 && mytHour < 20) {
        return { name: "LONDON", tp: 15, sl: 12, desc: "Volatility sederhana, breakout." };
    } else if (mytHour >= 20 || mytHour < 2) {
        return { name: "NEW YORK", tp: 25, sl: 18, desc: "Volatility tinggi, pergerakan besar." };
    } else {
        return { name: "LATE NY", tp: 20, sl: 15, desc: "Pergerakan bercampur." };
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
                return { 
                    latestPrice: closes[0], 
                    history: [...closes].reverse() 
                };
            }
        } catch(e){}
    }
    throw new Error("TwelveData limit atau API Key tak sah");
}

// Endpoint Utama
app.get('/api/generate-signal', async (req, res) => {
    try {
        const m = await getMarketData("XAU/USD");
        const session = getActiveSession();
        
        // Prompt AI (Di-inject dengan data harga & jarak TP/SL dinamik)
        const prompt = `
        Pair: XAU/USD. Current Price: ${m.latestPrice}. 
        Recent History (Old to New): ${m.history.join(', ')}.
        Current Session: ${session.name} (${session.desc}).
        
        Analyze the trend. Reply ONLY JSON format:
        {"pair":"XAU/USD","action":"BUY" or "SELL","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Short reason"}
        
        RULES:
        - If action is BUY: tp1 must be roughly (Entry + ${session.tp}), stop_loss roughly (Entry - ${session.sl}).
        - If action is SELL: tp1 must be roughly (Entry - ${session.tp}), stop_loss roughly (Entry + ${session.sl}).
        `;

        let text = "";
        let success = false;
        let lastError = "";

        // Loop melalui senarai model Groq
        for (let modelName of GROQ_MODELS) {
            try {
                console.log(`Cuba model: ${modelName}...`);
                
                const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        response_format: { type: "json_object" },
                        temperature: 0.3 
                    })
                });

                const data = await response.json();

                if (data.error) {
                    console.log(`Model ${modelName} gagal: ${data.error.message}`);
                    lastError = data.error.message;
                    continue; 
                }

                text = data.choices[0].message.content;
                success = true;
                console.log(`Berjaya guna model: ${modelName}`);
                break; 

            } catch (err) {
                lastError = err.message;
            }
        }

        if (!success) {
            throw new Error("Semua model AI gagal. Ralat: " + lastError);
        }
        
        // Bersihkan markdown dan hantar ke HTML
        text = text.replace(/```json|```/g, '').trim();
        const signalData = JSON.parse(text);
        
        // Sisipkan info sesi untuk dipaparkan di UI
        signalData.session_active = session.name; 
        
        res.json(signalData);

    } catch (e) {
        console.error("Ralat Sistem:", e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server berjalan di port " + PORT));