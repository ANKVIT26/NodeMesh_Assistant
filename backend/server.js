import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import Groq from 'groq-sdk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- INITIALIZATION & SECURITY ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Trust Render Proxy for Rate Limiting
app.set('trust proxy', 1); 

app.use(helmet()); //
app.use(express.json());

const allowedOrigins = [
  'https://nodemesh-ai-frontend.onrender.com', 
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, //
  message: { reply: "Too many requests. Please try again later." }
});
app.use('/chat', limiter);

// --- MEMORY STORAGE ---
// Volatile in-memory store for context
const sessionStore = new Map();
const MAX_HISTORY_TURNS = 6; 

function getSessionHistory(sessionId) {
  if (!sessionStore.has(sessionId)) sessionStore.set(sessionId, []);
  return sessionStore.get(sessionId);
}

function updateSessionHistory(sessionId, role, content) {
  const history = getSessionHistory(sessionId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY_TURNS * 2) {
    sessionStore.set(sessionId, history.slice(-(MAX_HISTORY_TURNS * 2)));
  }
}

// --- SUBSTANTIVE WEATHER HANDLER ---
async function handleWeather(location) {
  if (!WEATHER_API_KEY) return 'Weather service not configured.';
  try {
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(location)}&days=1`;
    const { data } = await axios.get(url);
    
    const loc = data.location;
    const current = data.current;
    const astro = data.forecast.forecastday[0].astro;

    // Formatting Local Time
    const localDate = new Date(loc.localtime.replace(' ', 'T'));
    const timeStr = localDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dateStr = localDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    let response = `**Weather for ${loc.name}, ${loc.region}**\n`;
    response += `📅 ${dateStr}\n🕐 Local Time: ${timeStr}\n\n`;
    response += `**Condition:** ${current.condition.text}\n`;
    response += `🌡️ **Temp:** ${current.temp_c}°C (Feels like: ${current.feelslike_c}°C)\n`;
    response += `💧 **Humidity:** ${current.humidity}% | 💨 **Wind:** ${current.wind_kph} km/h ${current.wind_dir}\n`;
    response += `🌅 **Sunrise:** ${astro.sunrise} | 🌇 **Sunset:** ${astro.sunset}`;

    // Add-on: Outdoor Activities based on data
    const activityPrompt = `Weather: ${current.condition.text}, ${current.temp_c}°C. Suggest 3 brief outdoor activities.`;
    const activities = await groq.chat.completions.create({
      messages: [{ role: "user", content: activityPrompt }],
      model: "llama-3.1-8b-instant",
    });
    response += `\n\n**🏃 Suggested Activities:**\n${activities.choices[0].message.content}`;

    return response;
  } catch (error) {
    return `I couldn't find weather for "${location}". Please try a more specific city.`;
  }
}

// --- ANALYSIS FUNCTIONS (Sarcasm & Gita) ---
async function analyzeSarcasm(userMessage) {
  const prompt = `Analyze for sarcasm: "${userMessage}". JSON: {"is_sarcastic": bool, "literal_meaning": "", "intended_meaning": ""}`;
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: "system", content: "Expert linguist. Output ONLY JSON." }, { role: "user", content: prompt }],
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" } //
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch { return { is_sarcastic: false }; }
}

async function getGitaSupport(userMessage) {
  const prompt = `User feels: "${userMessage}". Select best Gita verse. JSON: {"sanskrit": "", "translit": "", "meaning": ""}`;
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "Wise spiritual guide. Knowledge Bank: Anxiety(2.47), Restless(6.26), Despair(2.14). Output ONLY JSON." },
        { role: "user", content: prompt }
      ],
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" }
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch { return null; }
}

// --- MAIN CHAT LOGIC ---
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  try {
    // 1. Intent Detection
    const intentPrompt = `Intent: "${message}"? (weather/general). JSON: {"intent": "", "location": ""}`;
    const intentRaw = await groq.chat.completions.create({
      messages: [{ role: "user", content: intentPrompt }],
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" }
    });
    const { intent, location } = JSON.parse(intentRaw.choices[0].message.content);

    let reply;
    if (intent === 'weather') {
      reply = await handleWeather(location || message);
    } else {
      // 2. Sarcasm & Sentiment Analysis
      const [sarcasm, sentiment] = await Promise.all([
        analyzeSarcasm(message),
        groq.chat.completions.create({
          messages: [{ role: "user", content: `Is this low mood? "${message}". JSON: {"low": bool}` }],
          model: "llama-3.1-8b-instant",
          response_format: { type: "json_object" }
        })
      ]);

      const isLowMood = JSON.parse(sentiment.choices[0].message.content).low;

      if (isLowMood) {
        const gita = await getGitaSupport(message);
        reply = `I sense you're going through a lot. A short but surreal shlok from the Bhagvad Gita:\n\n**${gita.sanskrit}**\n*${gita.translit}*\n\n${gita.meaning}`;
      } else {
        // 3. General Chat with Memory
        const history = getSessionHistory(sessionId);
        const isEssay = /essay|elaborate|detailed/i.test(message);
        
        const completion = await groq.chat.completions.create({
          messages: [
            { role: "system", content: isEssay ? "Provide a detailed essay." : "You are NodeMesh. Answer crisp and concise (max 200 words)." },
            ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
            { role: "user", content: message }
          ],
          model: "llama-3.3-70b-versatile",
          max_tokens: isEssay ? 300 : 180
        });
        reply = completion.choices[0].message.content;
      }
    }

    updateSessionHistory(sessionId, "user", message);
    updateSessionHistory(sessionId, "assistant", reply);
    res.json({ reply, intent });

  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: "Couldn't reach the api server. Try again after atleast an hour." });
  }
});

app.listen(PORT, () => console.log(`NodeMesh running on port ${PORT}`));
