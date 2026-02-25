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

// --- INITIALIZATION ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

// --- SECURITY & PROXY ---
app.set('trust proxy', 1); 
app.use(helmet());
app.use(express.json());

const allowedOrigins = ['https://nodemesh-ai-frontend.onrender.com', 'http://localhost:5173'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { reply: "⚠️ **WARNING: Rate limit exceeded. Please wait 15 minutes.**" }
});
app.use('/chat', limiter);

// --- MEMORY STORAGE ---
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


async function handleWeather(location) {
  if (!WEATHER_API_KEY) return '⚠️ **WARNING: Weather API Key is missing!**';
  try {
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(location)}&days=1`;
    const { data } = await axios.get(url);
    const loc = data.location;
    const current = data.current;
    const forecastDay = data.forecast.forecastday[0].day;
    const astro = data.forecast.forecastday[0].astro;

    // --- RAIN DATA EXTRACTION ---
    const willItRain = forecastDay.daily_will_it_rain; // 1 for yes, 0 for no
    const rainAmount = forecastDay.totalprecip_mm;    // Total precipitation in mm
    const rainChance = forecastDay.daily_chance_of_rain;

    // Determine Logic-Based Expectation
    let expectation = "☀️ **Clear Skies/Sunny Expected**";
    if (willItRain === 1 || rainAmount > 0) {
      expectation = `🌧️ **Rain Expected: ${rainAmount}mm total (${rainChance}% chance)**`;
    }

    const localDate = new Date(loc.localtime.replace(' ', 'T'));
    const timeStr = localDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    
    let response = `**Weather for ${loc.name}, ${loc.region}**\n`;
    response += `📅 ${localDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n🕐 Local Time: ${timeStr}\n\n`;
    response += `**Status:** ${expectation}\n`;
    response += `**Condition:** ${current.condition.text}\n`;
    response += `🌡️ **Temp:** ${current.temp_c}°C (Feels like: ${current.feelslike_c}°C)\n`;
    response += `💧 **Humidity:** ${current.humidity}% | 💨 **Wind:** ${current.wind_kph} km/h ${current.wind_dir}\n`;
    response += `🌅 **Sunrise:** ${astro.sunrise} | 🌇 **Sunset:** ${astro.sunset}`;

    // --- ENHANCED RECOMMENDATION LOGIC ---
    const activityPrompt = `
      Weather Condition: ${current.condition.text}
      Expectation: ${expectation}
      Rain Amount: ${rainAmount}mm
      Temperature: ${current.temp_c}°C
      
      Instructions:
      1. If Rain Amount is 0mm and Will_it_rain is 0: Suggest outdoor activities like visiting monuments, swimming, or fishing.
      2. If Rain Amount > 0mm or Will_it_rain is 1: Suggest indoor activities like shopping malls, indoor museums, or cozy cafes.
      Provide 3 brief, engaging points.`;

    const activities = await groq.chat.completions.create({
      messages: [{ role: "user", content: activityPrompt }],
      model: "llama-3.1-8b-instant",
    });
    
    response += `\n\n**🏃 Smart Recommendations:**\n${activities.choices[0].message.content}`;

    return response;
  } catch (error) { 
    return `⚠️ **WARNING: Could not find weather for "${location}". Check spelling.**`; 
  }
}


async function handleNews(originalMessage) {
  if (!NEWS_API_KEY) return '⚠️ **WARNING: News API Key is missing!**';
  
  const lowerMsg = originalMessage.toLowerCase();
  
  // Regional Detection
  const countryCode = /india|indian|delhi|mumbai|bangalore/i.test(lowerMsg) ? 'in' : 'us';
  
  // Categorization
  let category = 'general';
  if (/business|finance|stock|market/i.test(lowerMsg)) category = 'business';
  else if (/health|medical|doctor|virus/i.test(lowerMsg)) category = 'health';
  else if (/tech|software|gadget|ai|coding/i.test(lowerMsg)) category = 'technology';
  else if (/education|school|university|exam/i.test(lowerMsg)) category = 'science'; 

  try {
    const { data } = await axios.get(`https://newsapi.org/v2/top-headlines`, {
      params: { country: countryCode, category, pageSize: 5 },
      headers: { 'X-Api-Key': NEWS_API_KEY }
    });

    if (!data.articles?.length) return `**No recent ${category} news found for ${countryCode.toUpperCase()} right now.**`;

    const articles = data.articles.map((a, i) => `**${i + 1}. ${a.title}**\n   📰 _${a.source.name}_ • [Read Full](${a.url})`).join('\n\n');
    return `**📰 Top ${category.toUpperCase()} Headlines (${countryCode.toUpperCase()}):**\n\n${articles}`;
  } catch (error) { return "⚠️ **WARNING: News service is currently unreachable.**"; }
}

// --- ANALYSIS FUNCTIONS ---
async function analyzeSarcasm(userMessage) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: "system", content: "Expert linguist. Output ONLY JSON: {\"is_sarcastic\": bool, \"intended_meaning\": \"string\"}" }, { role: "user", content: userMessage }],
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" }
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch { return { is_sarcastic: false }; }
}

async function getGitaSupport(userMessage) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "Wise spiritual guide. Knowledge Bank: Anxiety(2.47), Restless(6.26), Despair(2.14). Output ONLY JSON: {\"sanskrit\": \"\", \"translit\": \"\", \"meaning\": \"\"}" },
        { role: "user", content: userMessage }
      ],
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" }
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch { return null; }
}

// --- MAIN CHAT ENDPOINT ---
app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  try {
    // Intent Detection
    const intentPrompt = `Classify intent: "${message}". JSON: {"intent": "weather|news|general", "location": "string"}`;
    const intentRaw = await groq.chat.completions.create({
      messages: [{ role: "user", content: intentPrompt }],
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" }
    });
    const { intent, location } = JSON.parse(intentRaw.choices[0].message.content);

    let reply;
    if (intent === 'weather') {
      reply = await handleWeather(location || message);
    } else if (intent === 'news') {
      reply = await handleNews(message);
    } else {
      const [sarcasm, sentimentRaw] = await Promise.all([
        analyzeSarcasm(message),
        groq.chat.completions.create({
          messages: [{ role: "user", content: `Is this low mood? "${message}". JSON: {"low": bool}` }],
          model: "llama-3.1-8b-instant",
          response_format: { type: "json_object" }
        })
      ]);

      if (JSON.parse(sentimentRaw.choices[0].message.content).low) {
        const gita = await getGitaSupport(message);
        reply = `**Bhagavad Gita Spiritual Support:**\n\n**${gita.sanskrit}**\n*${gita.translit}*\n\n${gita.meaning}`;
      } else {
        const history = getSessionHistory(sessionId);
        const isEssay = /essay|elaborate|detailed/i.test(message);
        const completion = await groq.chat.completions.create({
          messages: [
            { role: "system", content: isEssay ? "Detailed Essay mode." : "You are NodeMesh. Answer crisp/concise (max 200 words)." },
            ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
            { role: "user", content: sarcasm.is_sarcastic ? `(User meant: ${sarcasm.intended_meaning}) ${message}` : message }
          ],
          model: "llama-3.3-70b-versatile",
          max_tokens: isEssay ? 2000 : 400
        });
        reply = completion.choices[0].message.content;
      }
    }

    updateSessionHistory(sessionId, "user", message);
    updateSessionHistory(sessionId, "assistant", reply);
    res.json({ reply, intent });

  } catch (error) {
    console.error("Critical Error:", error);
    res.status(500).json({ error: "⚠️ **WARNING: Critical processing failure on server.**" });
  }
});

app.listen(PORT, () => console.log(`NodeMesh running on port ${PORT}`));
