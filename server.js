const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Ambil API Keys dari Environment Variables Render
const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY,
    process.env.TWELVEDATA_API_KEY_2,
    process.env.TWELVEDATA_API_KEY_3
].filter(Boolean); // Buang jika ada yang kosong

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// 2. Fungsi ambil data dari TwelveData (Sistem Backup Key)
async function getMarketData(symbol) {
    for (let i = 0; i < TD_KEYS.length; i++) {
        try {
            const response = await axios.get(`https://api.twelvedata.com/time_series`, {
                params: {
                    symbol: symbol, 
                    interval: '1h',
                    outputsize: 5, // Ambil 5 harga terakhir
                    apikey: TD_KEYS[i]
                }
            });

            if (response.data.status !== "error" && response.data.values) {
                return {
                    latestPrice: response.data.values[0].close,
                    history: response.data.values.map(v => v.close)
                };
            } else {
                console.log(`API Key ${i+1} gagal: ${response.data.message}`);
            }
        } catch (err) {
            console.log(`API Key ${i+1} error. Cuba key seterusnya...`);
        }
    }
    throw new Error("Semua TwelveData API Key dah limit atau gagal.");
}

// 3. Endpoint untuk dipanggil oleh HTML
app.get('/api/generate-signal', async (req, res) => {
    try {
        const pair = "XAU/USD"; // Anda boleh tukar ke EUR/USD, GBP/USD, dll.

        // Ambil Data Pasaran
        const marketData = await getMarketData(pair);

        // Sediakan Prompt untuk DeepSeek
        const prompt = `
            Anda adalah pakar analisis teknikal Forex.
            Pair: ${pair}
            Harga Terkini: ${marketData.latestPrice}
            Sejarah 5 Harga Terakhir (Lama ke Baru): ${marketData.history.join(', ')}
            
            Berdasarkan data ini, berikan signal trading. Jawab HANYA dalam format JSON tanpa sebarang teks lain:
            {
                "pair": "${pair}",
                "action": "BUY" atau "SELL",
                "entry": ${marketData.latestPrice},
                "tp1": [letak nilai harga sasaran],
                "stop_loss": [letak nilai harga stop loss],
                "confidence": [letak nombor 1-100],
                "reason": "[sebab ringkas maks 10 patah perkataan]"
            }
        `;

        // Hantar ke DeepSeek API
        const aiResponse = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.3 // Rendah supaya AI tak merepek
        }, {
            headers: { 
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // Parse jawapan AI dan hantar ke HTML
        const signalData = JSON.parse(aiResponse.data.choices[0].message.content);
        res.json(signalData);

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: "Sistem sibuk atau API limit. Sila cuba lagi." });
    }
});

// 4. Jalankan Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));