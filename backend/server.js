import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// --- 1. STARTUP CHECKS ---
console.log('--- Checking Environment Variables on STARTUP ---');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const DISABLE_GEMINI = (process.env.DISABLE_GEMINI || 'false').toLowerCase() === 'true';

if (GEMINI_API_KEY) {
  console.log(`GEMINI_API_KEY active. Ends with: ${GEMINI_API_KEY.slice(-3)}`);
} else {
  console.error('CRITICAL: GEMINI_API_KEY is missing!');
}

const app = express();
const PORT = process.env.PORT || 3001;
let lastContextLocation = null; 

// 2025 Recommended Model Nest
const DEFAULT_MODEL = 'gemini-2.5-flash-lite'; 

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
const http = axios.create({ timeout: 15000 });

// --- UTILITIES ---
function extractJson(text) {
  if (!text) return null;
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/); 
  const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2]) : text;
  try { return JSON.parse(jsonString.trim()); } catch (e) { return null; }
}

async function callGemini(input, model = DEFAULT_MODEL) {
  if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  
  // Cleaned 2025 Nest (Removed deprecated "-latest" tags)
  const modelsToTry = [model, 'gemini-2.5-flash-lite', 'gemini-1.5-flash', 'gemini-2.0-flash'];
  let lastError;
  const contents = Array.isArray(input) ? input : [{ parts: [{ text: input }] }];

  for (const m of modelsToTry) {
    try {
      // BURST SAFETY: 1.2s delay prevents "False" 429s on free/new paid projects
      await new Promise(r => setTimeout(r, 1200)); 

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await http.post(url, {
        contents,
        safetySettings: [{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" }]
      });

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (error) {
      lastError = error;
      if (error.response?.status === 429) {
        console.warn(`⚠️ Rate limit on ${m}. Waiting 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (error.response?.status === 404) continue;
      if (error.response?.status === 400) break;
    }
  }
  throw lastError || new Error('All models failed');
}

// --- FEATURE 1: INTENT & ANALYSIS ---

function fallbackIntentDetection(userMessage) {
    const lower = userMessage.toLowerCase();
    // FIX FOR PUNE: Extract city if AI fails
    const locMatch = userMessage.match(/(?:in|for|at|of)\s+([a-zA-Z]+)/i);
    const location = locMatch ? locMatch[1] : '';

    if (/(weather|forecast|temp|rain|snow|storm|climate)/i.test(lower)) 
      return { intent: 'weather', location, activity: '' };
    if (/(news|headline|article|update)/i.test(lower)) 
      return { intent: 'news', topic: '' };
    return { intent: 'general' };
}

async function detectIntent(userMessage) {
  const prompt = `Classify user message into: "weather", "news", or "general". 
  Extract "location", "activity", or "topic". 
  Respond ONLY with JSON: {"intent": "...", "location": "...", "topic": "...", "activity": "..."}
  User: "${userMessage}"`;
  try {
    if (!DISABLE_GEMINI) {
      const raw = await callGemini(prompt);
      return extractJson(raw) || fallbackIntentDetection(userMessage);
    }
  } catch (e) { console.error('Intent Detection AI failed, using fallback.'); }
  return fallbackIntentDetection(userMessage);
}

async function analyzeSarcasm(msg) {
  try { return extractJson(await callGemini(`Analyze for sarcasm. JSON: {"is_sarcastic": boolean, "intended_meaning": "string"}. Message: "${msg}"`)); } 
  catch (e) { return null; }
}

async function analyzeSentiment(msg) {
  try { return extractJson(await callGemini(`Is user low/sad/worried? JSON: {"is_low_mood": boolean}. Message: "${msg}"`)); } 
  catch (e) { return { is_low_mood: false }; }
}

async function getGitaSupport(msg) {
  try { return extractJson(await callGemini(`Wise guide from Bhagavad Gita. JSON: {"sanskrit": "...", "english_transliteration": "...", "meaning": "..."} Context: ${msg}`)); } 
  catch (e) { return null; }
}

// --- FEATURE 2: WEATHER (Fixed Pune/Tawang/Nashik) ---

async function handleWeather(location, activity, history = []) {
  if (!WEATHER_API_KEY) return 'Weather service not configured.';
  
  let query = String(location || "").trim();
  if (query && !query.toLowerCase().includes('india')) query = `${query}, India`;
  if (!query) return 'Please provide a valid location (e.g. Weather in Pune).';

  try {
    const { data } = await http.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: WEATHER_API_KEY, q: query, days: 1 }
    });

    const c = data.current;
    const loc = data.location;
    const astro = data.forecast?.forecastday?.[0]?.astro;
    const localTime = new Date(loc.localtime).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

    let response = `**Weather for ${loc.name}, ${loc.region}, ${loc.country}**\n` +
                   `🕐 Local Time: ${localTime}\n` +
                   `**Condition:** ${c.condition.text}\n` +
                   `🌡️ **Temp:** ${c.temp_c}°C (Feels like: ${c.feelslike_c}°C)\n` +
                   `💧 **Humidity:** ${c.humidity}% | 💨 **Wind:** ${c.wind_kph} km/h\n` +
                   `🌅 **Sunrise:** ${astro?.sunrise} | 🌇 **Sunset:** ${astro?.sunset}`;

    if (activity) {
      const advice = await callGemini(`Weather is ${c.condition.text}, ${c.temp_c}C. Advice for "${activity}"?`);
      response += `\n\n**Activity Outlook (${activity}):**\n${advice}`;
    }
    return response;
  } catch (e) { return `I couldn't find precise weather for "${location}". Try adding the state name.`; }
}

// --- FEATURE 3: NEWS (India vs US) ---

async function handleNews(topic, originalMessage) {
  if (!NEWS_API_KEY) return 'News service not configured.';
  const isIndia = /india/i.test(originalMessage) || /india/i.test(topic || '');

  try {
    const { data } = await http.get('https://newsapi.org/v2/top-headlines', {
      params: { country: isIndia ? 'in' : 'us', q: topic || undefined, pageSize: 5 },
      headers: { 'X-Api-Key': NEWS_API_KEY }
    });
    
    if (!data.articles?.length) return "No recent news found.";
    const newsItems = data.articles.map((a, i) => `**${i + 1}. ${a.title}**\n📰 *${a.source.name}* [Read](${a.url})`).join('\n\n');
    return `**📰 Latest ${isIndia ? 'India' : 'US'} Headlines:**\n\n${newsItems}`;
  } catch (e) { return "Sorry, I couldn't fetch the news right now."; }
}

// --- FEATURE 4: GENERAL & GITA ---

async function handleGeneralResponse(userMessage, history) {
  const distress = /(worried|sad|depressed|anxious|tired)/i.test(userMessage);
  let sarcasm = await analyzeSarcasm(userMessage);
  let sentiment = distress ? { is_low_mood: true } : await analyzeSentiment(userMessage);

  if (sentiment?.is_low_mood) {
    const gita = await getGitaSupport(userMessage);
    if (gita) return `I sense you're struggling. Wisdom from the Gita:\n\n**${gita.sanskrit}**\n*${gita.english_transliteration}*\n\n${gita.meaning}`;
  }

  let sys = "You are NodeMesh, a helpful AI assistant.";
  if (sarcasm?.is_sarcastic) sys += " User is sarcastic, respond with wit.";

  const chat = [{ role: "user", parts: [{ text: `System: ${sys}` }] }, { role: "model", parts: [{ text: "OK" }] }, ...history, { role: "user", parts: [{ text: userMessage }] }];
  try { return await callGemini(chat); } catch (e) { return "I'm here if you need to talk."; }
}

// --- ROUTES ---

app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required.' });

  try {
    console.log(`New Request: "${message}"`);
    let { intent, location, topic, activity } = await detectIntent(message);
    
    if (location && location.length > 0) lastContextLocation = location;
    if (!location && (intent === 'weather' || activity)) location = lastContextLocation;

    let reply;
    if (intent === 'weather') reply = await handleWeather(location, activity, history);
    else if (intent === 'news') reply = await handleNews(topic, message);
    else reply = await handleGeneralResponse(message, history);

    res.json({ reply, intent, location, topic });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
