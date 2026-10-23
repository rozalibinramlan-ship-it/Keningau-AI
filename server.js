const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json());

// =====================================================================
// 1. MASUKKAN API KEYS ANDA DI SINI
// (Jika anda guna Environment Variables di Render, biarkan 'process.env...')
// =====================================================================
const TD_KEYS = [
    process.env.TWELVEDATA_API_KEY || 'LETAK_TWELVEDATA_KEY_1_DISINI',
    process.env.TWELVEDATA_API_KEY_2 || 'LETAK_TWELVEDATA_KEY_2_DISINI',
    process.env.TWELVEDATA_API_KEY_3 || 'LETAK_TWELVEDATA_KEY_3_DISINI'
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'LETAK_GEMINI_API_KEY_DISINI';

// Setup Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// =====================================================================
// 2. FUNGSI AMBIL DATA DARI TWELVEDATA
// =====================================================================
async function getMarketData(symbol) {
    for (let i = 0; i < TD_KEYS.length; i++) {
        // Langkau jika key kosong
        if (!TD_KEYS[i] || TD_KEYS[i].includes('LETAK_')) continue;

        try {
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1h&outputsize=5&apikey=${TD_KEYS[i]}`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.status !== "error" && data.values) {
                return {
                    latestPrice: data.values[0].close,
                    history: data.values.map(v => v.close)
                };
            } else {
                console.log(`API Key ${i+1} gagal: ${data.message}`);
            }
        } catch (err) {
            console.log(`API Key ${i+1} error. Cuba key seterusnya...`);
        }
    }
    throw new Error("Semua TwelveData API Key dah limit atau gagal.");
}

// =====================================================================
// 3. ENDPOINT UNTUK DIPANGGIL OLEH HTML
// =====================================================================
app.get('/api/generate-signal', async (req, res) => {
    try {
        const pair = "XAU/USD"; // Anda boleh tukar pair di sini

        // Ambil Data Pasaran
        const marketData = await getMarketData(pair);

        // Sediakan Prompt untuk Gemini
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

        // Panggil Gemini (Guna model gemini-1.5-flash)
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" } // Paksa bagi format JSON
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Parse jawapan AI dan hantar ke HTML
        const signalData = JSON.parse(text);
        res.json(signalData);

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: "Ralat: " + error.message });
    }
});

// =====================================================================
// 4. JALANKAN SERVER
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));