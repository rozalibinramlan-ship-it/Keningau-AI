const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Ambil API Keys TwelveData dari Render
const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY, 
    process.env.TWELVEDATA_API_KEY_2, 
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean);

// Fungsi ambil data dari TwelveData
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

// Endpoint untuk HTML panggil
app.get('/api/generate-signal', async (req, res) => {
    try {
        const m = await getMarketData("XAU/USD");
        
        // Prompt arahan untuk AI
        const prompt = `Pair XAU/USD Price ${m.latestPrice} History ${m.history.join(',')} Reply ONLY JSON: {"pair":"XAU/USD","action":"BUY","entry":${m.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Fresh demand"}. tp1/sl +/- 20 dollars.`;

        // Panggil API Groq
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant", // Model terbaru Groq
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" } // Paksa output JSON
            })
        });

        const data = await response.json();
        
        // Semak jika Groq pulangkan error
        if (data.error) {
            throw new Error(data.error.message);
        }

        let text = data.choices[0].message.content;
        
        // Bersihkan markdown jika AI degil bagi ```json
        text = text.replace(/```json|```/g, '').trim();
        
        // Hantar JSON ke HTML
        res.json(JSON.parse(text));

    } catch (e) {
        console.error("Ralat:", e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server berjalan di port " + PORT));