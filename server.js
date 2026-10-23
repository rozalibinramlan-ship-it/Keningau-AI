const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Ambil API Keys TwelveData
const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY, 
    process.env.TWELVEDATA_API_KEY_2, 
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean); // Buang yang kosong

// 2. Fungsi Ambil Data Harga Emas
async function getMarketData(symbol) {
    for (let key of TD_KEYS) {
        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1h&outputsize=10&apikey=${key}`;
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
            console.log(`TwelveData key gagal, cuba key seterusnya...`);
        }
    }
    throw new Error("TwelveData limit atau API Key tak sah.");
}

// 3. Endpoint API untuk HTML
app.get('/api/generate-signal', async (req, res) => {
    try {
        const marketData = await getMarketData("XAU/USD");

        // Sediakan Prompt
        const prompt = `
        Pair: XAU/USD, Price: ${marketData.latestPrice}, History: ${marketData.history.join(', ')}
        Give signal. Reply ONLY valid JSON: {"pair":"XAU/USD","action":"BUY","entry":${marketData.latestPrice},"tp1":0,"stop_loss":0,"confidence":85,"reason":"Fresh demand bounce"}
        tp1 and stop_loss must be realistic price for Gold, +/- 15 to 35 dollars from entry.
        `;

        // 4. Panggil Groq API (Menggunakan Model Llama 3)
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama3-8b-8192", 
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }, // Paksa AI bagi JSON sahaja
                temperature: 0.3 // Rendah supaya tak merepek
            })
        });

        const groqData = await groqResponse.json();

        // Semak jika Groq pulangkan ralat
        if (groqData.error) {
            throw new Error(groqData.error.message);
        }

        // Ambil jawapan AI
        let text = groqData.choices[0].message.content;
        
        // Bersihkan markdown kalau AI degil letak ```json
        text = text.replace(/```json|```/g, '').trim();
        
        // Hantar JSON ke HTML
        const signalData = JSON.parse(text);
        res.json(signalData);

    } catch (error) {
        console.error("Ralat Sistem:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. Jalankan Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));