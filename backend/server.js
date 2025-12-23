import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// --- 1. STARTUP CHECKS ---
console.log('--- Checking Environment Variables on STARTUP ---');
const apiKeyFromEnv = process.env.GEMINI_API_KEY;
if (apiKeyFromEnv) {
  console.log(`GEMINI_API_KEY found. Ends with: ${apiKeyFromEnv.substring(apiKeyFromEnv.length - 3)}`);
} else {
  console.error('CRITICAL: GEMINI_API_KEY is missing!');
}
console.log('--- End Startup Check ---');

const app = express();
const PORT = process.env.PORT || 3001;

// Context Memory for Location (Persists until server restart)
let lastContextLocation = null; 

// FIX: gemini-2.0-flash is the correct current model ID for the free tier
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash'; 
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const DISABLE_GEMINI = (process.env.DISABLE_GEMINI || 'false').toLowerCase() === 'true';

const allowedOrigins = [
  'https://nodemesh-ai-frontend.onrender.com', 
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json());
const http = axios.create({ timeout: 15000 });

function extractJson(text) {
  if (!text) return null;
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/); 
  if (!jsonMatch) return null;
  const jsonString = jsonMatch[1] || jsonMatch[2]; 
  try {
    return JSON.parse(jsonString.trim()); 
  } catch (error) {
    console.error('Failed to parse JSON:', error.message);
    return null;
  }
}

async function callGemini(input, model = GEMINI_MODEL) {
  if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  const modelsToTry = [
    model, 
    'gemini-2.0-flash', 
    'gemini-1.5-flash-latest', 
    'gemini-1.5-flash-002'
  ];
  
  let lastError;
  let contents = Array.isArray(input) ? input : [{ parts: [{ text: input }] }];

  for (const m of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`;
    
    try {
      const response = await http.post(url, {
        contents: contents,
        safetySettings: [
          { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
          { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
          { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
          { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
        ]
      });

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;

      throw new Error('Empty response from Gemini');

    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      
      // FIX: Improved 429 handling with a slightly longer wait for free tier stabilization
      if (status === 429) {
        console.warn(`⚠️ Rate limit hit for ${m}. Waiting 3 seconds before retrying fallback...`);
        await new Promise(resolve => setTimeout(resolve, 3000)); 
        continue; 
      }

      if (status === 404 || status === 503) {
        console.warn(`🔄 Model ${m} unavailable (${status}). Trying next in nest...`);
        continue;
      }

      if (status === 400) break;
    }
  }
  
  throw lastError || new Error('All Gemini models in the nest failed to respond.');
}

function fallbackIntentDetection(userMessage) {
    const lower = userMessage.toLowerCase();
    const weatherKeywords = /(weather|forecast|temp|rain|snow|storm|climate|wind|humidity)/i;
    const newsKeywords = /(news|headline|article|update|breaking|latest)/i;

    if (weatherKeywords.test(lower)) return { intent: 'weather', location: '', activity: '' };
    if (newsKeywords.test(lower)) return { intent: 'news', topic: '' };
    return { intent: 'general' };
}

async function detectIntent(userMessage) {
  const prompt = `Classify the user message into: "weather", "news", or "general".
- Extract "location" if ANY city or country is mentioned (Default ambiguous to India).
- If user asks about outdoor activities, set intent to "weather" and extract "activity".
- If "news", extract "topic".
- Respond ONLY with JSON: {"intent": "...", "location": "...", "topic": "...", "activity": "..."}
User: "${userMessage}"`;

  try {
    if (!DISABLE_GEMINI) {
        const raw = await callGemini(prompt); 
        const parsed = extractJson(raw);
        if (parsed && parsed.intent) return parsed;
    }
  } catch (error) {
    console.error('Intent detection failed:', error.message);
  }
  return fallbackIntentDetection(userMessage);
}

async function analyzeSarcasm(userMessage) {
  const prompt = `Analyze for sarcasm. JSON: {"is_sarcastic": boolean, "intended_meaning": "string"}. Message: "${userMessage}"`;
  try {
    const raw = await callGemini(prompt); 
    return extractJson(raw); 
  } catch (error) { return null; }
}

async function analyzeSentiment(userMessage) {
  const prompt = `Does the user sound "low", "sad", "depressed", "anxious", "tired", or "worried"? JSON: {"is_low_mood": boolean}. Message: "${userMessage}"`;
  try {
    const raw = await callGemini(prompt);
    return extractJson(raw);
  } catch (error) { return { is_low_mood: false }; }
}

async function getGitaSupport(userMessage) {
  const prompt = `You are a wise spiritual guide rooted in the Bhagavad Gita. The user is feeling low/anxious.
  Respond STRICTLY in this JSON format:
  {
    "sanskrit": "Sanskrit verse",
    "english_transliteration": "English letters",
    "meaning": "Comforting explanation connecting verse to: ${userMessage}"
  }`;
  try {
    const raw = await callGemini(prompt);
    return extractJson(raw);
  } catch (error) { return null; }
}

// --- UPDATED WEATHER HANDLER (Fix for Tawang and Nashik) ---
async function handleWeather(location, activity, history = []) {
  if (!WEATHER_API_KEY) return 'Weather service is not configured.';
  
  let queryLocation = location;
  if (typeof location === 'object' && location !== null) {
    queryLocation = location.city || location.name || location.location || JSON.stringify(location);
  }
  queryLocation = String(queryLocation || "").trim();

  // FIX: Programmatic Contextual resolution for Tawang, Nashik, etc.
  // This appends context ONLY if it's missing, avoiding hardcoding massive lists.
  if (queryLocation && !queryLocation.toLowerCase().includes('india')) {
    queryLocation = `${queryLocation}, India`;
  }
  if (queryLocation.toLowerCase() === 'delhi') queryLocation = 'New Delhi, India';

  if (!queryLocation) return 'Please provide a valid location.';

  try {
    const { data } = await http.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: WEATHER_API_KEY, q: queryLocation, days: 1, aqi: 'no', alerts: 'no' }
    });

    const c = data.current;
    const loc = data.location;
    const astro = data.forecast?.forecastday?.[0]?.astro;

    let timeInfo = '';
    if (loc.localtime) {
        const localDate = new Date(loc.localtime);
        timeInfo = `📅 ${localDate.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} 🕐 Local Time: ${localDate.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}\n`;
    }

    let response = `**Weather for ${loc.name}, ${loc.region}, ${loc.country}**\n${timeInfo}` +
                   `**Condition:** ${c.condition.text}\n` +
                   `🌡️ **Temp:** ${c.temp_c}°C (Feels like: ${c.feelslike_c}°C)\n` +
                   `💧 **Humidity:** ${c.humidity}%\n` +
                   `💨 **Wind:** ${c.wind_kph} km/h ${c.wind_dir}\n` +
                   `🌅 **Sunrise:** ${astro?.sunrise || 'N/A'} | 🌇 **Sunset:** ${astro?.sunset || 'N/A'}`;

    if (activity) {
        const systemContext = `Advisor: Current weather in ${loc.name} is ${c.condition.text}, ${c.temp_c}C. User asks about: "${activity}".`;
        const conversation = [
            { role: "user", parts: [{ text: `System Context: ${systemContext}` }] },
            { role: "model", parts: [{ text: "Understood." }] },
            ...history,
            { role: "user", parts: [{ text: `Is it good for ${activity}?` }] }
        ];
        
        try {
            const advice = await callGemini(conversation);
            response += `\n\n**Activity Outlook (${activity}):**\n${advice}`;
        } catch (e) { response += `\n\n(Could not generate specific advice for ${activity})`; }
    }

    return response;

  } catch (error) {
    return `I couldn't find precise weather for "${location}". Try adding the state name.`;
  }
}

function extractNewsKeywords(text) {
    if (!text) return '';
    const blacklist = ['news','headline','latest','about','on','for','update'];
    return text.toLowerCase().split(/\s+/).filter(w => !blacklist.includes(w) && w.length > 2).join(' ');
}

async function handleNews(topic, originalMessage) {
    if (!NEWS_API_KEY) return 'News service is not configured.';

    try {
        const prompt = `Summarize the latest news request: "${originalMessage}". If specific facts, list them. Under 200 words.`;
        const raw = await callGemini(prompt);
        if (raw && !raw.includes("cannot fulfill")) return raw; 
    } catch (e) { 
        console.warn("Gemini news summary failed, using API fallback."); 
    }

    const keywords = extractNewsKeywords(topic || originalMessage);
    const isIndiaRequested = /india/i.test(originalMessage) || /india/i.test(topic || '');
    const countryCode = isIndiaRequested ? 'in' : 'us';

    try {
        const { data } = await http.get('https://newsapi.org/v2/top-headlines', {
            params: { 
                country: countryCode, 
                category: keywords ? undefined : 'general', 
                q: keywords || undefined, 
                pageSize: 5 
            },
            headers: { 'X-Api-Key': NEWS_API_KEY }
        });

        if (!data.articles?.length) return `No recent news articles found for ${isIndiaRequested ? 'India' : 'the US'}.`;

        const articles = data.articles.map((a, i) => 
            `**${i + 1}. ${a.title}**\n   📰 *${a.source.name}*` + (a.url ? ` • [Read](${a.url})` : '')
        ).join('\n\n');
        
        const header = isIndiaRequested ? 'Top India Headlines' : 'Latest Headlines';
        return `**📰 ${header}:**\n\n${articles}`;
    } catch (e) { 
        return "Sorry, I couldn't fetch the news right now."; 
    }
}

async function handleGeneralResponse(userMessage, history = []) {
  const lower = userMessage.toLowerCase();
  const distressKeywords = ['worried', 'worry', 'anxious', 'sad', 'depressed', 'tired'];
  const hasDistressKeyword = distressKeywords.some(word => lower.includes(word));
  const creativeKeywords = ['write', 'essay', 'story', 'poem', 'blog', 'article', 'code', 'script'];
  const isCreativeMode = creativeKeywords.some(word => lower.includes(word));

  let sarcasmResult = null;
  let sentimentResult = { is_low_mood: hasDistressKeyword };

  if (!DISABLE_GEMINI) {
    const tasks = [analyzeSarcasm(userMessage)];
    if (!hasDistressKeyword && !isCreativeMode) tasks.push(analyzeSentiment(userMessage));

    try {
      const results = await Promise.all(tasks);
      sarcasmResult = results[0];
      if (!hasDistressKeyword && !isCreativeMode && results[1]) sentimentResult = results[1];
    } catch (e) { console.error("Analysis failed", e); }
  }

  if (sentimentResult?.is_low_mood && !isCreativeMode) {
    const gitaData = await getGitaSupport(userMessage);
    if (gitaData) {
      return `I sense you might be going through a tough moment. Here is some timeless wisdom from the Bhagavad Gita:\n\n` +
             `**${gitaData.sanskrit}**\n` +
             `*${gitaData.english_transliteration}*\n\n` +
             `${gitaData.meaning}`;
    }
  }

  let systemText = isCreativeMode ? "You are NodeMesh, a creative AI assistant." : "You are NodeMesh, a helpful assistant.";
  if (sarcasmResult?.is_sarcastic) systemText += ` User is sarcastic. Be witty.`;

  const conversation = [
    { role: "user", parts: [{ text: `System Instruction: ${systemText}` }] },
    { role: "model", parts: [{ text: "Understood." }] },
    ...history,
    { role: "user", parts: [{ text: userMessage }] }
  ];

  try {
    return await callGemini(conversation); 
  } catch (e) { return "I'm here if you need to talk."; }
}

app.post('/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required.' });

  try {
    console.log(`\nNew Request: "${message}"`);
    let { intent, location, topic, activity } = await detectIntent(message);
    
    if (location && typeof location === 'string' && location.length > 0) lastContextLocation = location;
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

app.get('/', (_req, res) => res.send('NodeMesh Backend Running'));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
