import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// --- STARTUP DEBUG LOGGING ---
console.log('--- Checking Environment Variables on STARTUP ---');
const apiKeyFromEnv = process.env.GEMINI_API_KEY; //
if (apiKeyFromEnv) {
  // Log key parts securely
  console.log(`GEMINI_API_KEY found on startup. Starts with: ${apiKeyFromEnv.substring(0, 5)}, Ends with: ${apiKeyFromEnv.substring(apiKeyFromEnv.length - 4)}`); //
} else {
  console.log('GEMINI_API_KEY is NOT FOUND or empty in process.env on STARTUP!'); //
}
console.log('--- End Startup Check ---');
// --- END DEBUG LOGGING ---

const app = express();
const PORT = process.env.PORT || 3001; //

// --- MODEL CONFIGURATION ---
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'; //
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL; //
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const WEATHER_API_KEY = process.env.WEATHER_API_KEY; //
const NEWS_API_KEY = process.env.NEWS_API_KEY; //
const DISABLE_GEMINI = (process.env.DISABLE_GEMINI || 'false').toLowerCase() === 'true'; //

// --- MEMORY STORAGE ---
// In-memory store for context. In production, use Redis or a Database.
const sessionStore = new Map();
const MAX_HISTORY_TURNS = 6; 

const allowedOrigins = [
  'https://nodemesh-ai-frontend.onrender.com', 
  'http://localhost:5173'
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
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));
app.options('*', cors()); 

app.use(express.json());

// Axios instance with sane defaults
const http = axios.create({
  timeout: 15000, //
});

// --- HELPER FUNCTIONS ---

function getSessionHistory(sessionId) {
    if (!sessionStore.has(sessionId)) {
        sessionStore.set(sessionId, []);
    }
    return sessionStore.get(sessionId);
}

function updateSessionHistory(sessionId, role, text) {
    const history = getSessionHistory(sessionId);
    history.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text }] });
    
    // Maintain sliding window of last 6 turns (12 messages)
    if (history.length > MAX_HISTORY_TURNS * 2) {
        sessionStore.set(sessionId, history.slice(-(MAX_HISTORY_TURNS * 2)));
    }
}

function extractJson(text) {
  if (!text) return null; //
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/); 
  if (!jsonMatch) return null;
  
  const jsonString = jsonMatch[1] || jsonMatch[2]; 
  if (!jsonString) return null;
  
  try {
    return JSON.parse(jsonString.trim()); 
  } catch (error) {
    console.error('Failed to parse JSON from Gemini response:', error.message);
    return null;
  }
}

// Updated callGemini with optional maxTokens parameter
async function callGemini(prompt, model = GEMINI_MODEL, history = [], maxTokens = undefined) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY environment variable');
  }

  const modelsToTry = [];
  if (model) modelsToTry.push(model);
  if (!modelsToTry.includes('gemini-2.0-flash')) modelsToTry.push('gemini-2.0-flash');

  let lastError;
  for (const m of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`;
    console.log(`Attempting Gemini call to model: ${m}`);
    
    try {
      const contents = [...history];
      if (prompt) {
          contents.push({ role: 'user', parts: [{ text: prompt }] });
      }

      // --- DYNAMIC CONFIGURATION ---
      // This ensures we ONLY set a limit if 'maxTokens' is passed.
      // If maxTokens is undefined (like in Weather/News), no limit is sent.
      const generationConfig = {}; 
      if (maxTokens) {
          generationConfig.maxOutputTokens = maxTokens;
      }

      const response = await http.post(url, {
        contents: contents,
        generationConfig: generationConfig, // Pass the dynamic config object
        safetySettings: [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
        ]
      });

      const candidates = response.data?.candidates;
      if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
        lastError = new Error('No candidates in Gemini response');
        continue;
      }
      
      const parts = candidates[0]?.content?.parts;
      const textParts = parts
        ?.filter(part => part && typeof part.text === 'string')
        .map(part => part.text);

      const candidate = textParts?.join('');
      if (candidate) {
        return candidate;
      }
      lastError = new Error('Empty text content from Gemini response');

    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retriable = status === 429 || status === 500 || status === 503 || error.code === 'ECONNABORTED'; 
      console.warn(`Gemini call failed for model ${m}. ${retriable ? 'Trying next fallback...' : ''}`);
      if (!retriable) break; 
    }
  }
  throw lastError || new Error('Gemini call failed after trying all fallbacks');
}
// --- INTENT DETECTION ---

function fallbackIntentDetection(userMessage) {
    const lower = userMessage.toLowerCase();
    const weatherKeywords = /(weather|forecast|temp|temperature|rain|snow|storm|climate|alert|alerts|wind|humidity|sun|cloudy|condition|conditions)/i; //
    const newsKeywords = /(news|headline|headlines|article|articles|update|updates|breaking|latest|today's|report|current|developments)/i; //

    if (weatherKeywords.test(lower)) {
        // [Existing regex logic preserved from source]
        let location = '';
        const locationMatch = userMessage.match(/(?:in|for|at|weather|how is the|what is the|show me the)\s+([A-Z][A-Za-z\s,.'-]+)(?:[\.!,?]|$)/i); //
        if (locationMatch && locationMatch[1]) location = locationMatch[1].trim().replace(/['.]/g, '');
        if (!location) {
             const cleaned = userMessage.replace(weatherKeywords, '').replace(/\b(?:what is|what's|how is|how's|tell me about|about|the|get me the)\b/gi, '').trim(); //
             if (cleaned && /^[A-Z]/.test(cleaned)) location = cleaned.replace(/['.]/g, '');
        }
        return { intent: 'weather', location: location || '', topic: '' };
    }

    if (newsKeywords.test(lower)) {
        // [Existing regex logic preserved from source]
        let topic = '';
        const topicMatch = userMessage.match(/(?:about|on|regarding|of|news|headlines|latest|updates)\s+([A-Za-z0-9\s,.'-]+)(?:[\.!,?]|$)/i); //
        if (topicMatch && topicMatch[1]) topic = topicMatch[1].trim().replace(/['.]/g, '');
        if (!topic) {
             const cleaned = userMessage.replace(newsKeywords, '').replace(/\b(?:about|on|regarding|of|for|the|latest|top|get me)\b/gi, '').trim(); //
             if (cleaned) topic = cleaned.replace(/['.]/g, '');
        }
        return { intent: 'news', location: '', topic: topic || '' };
    }

    return { intent: 'general', location: '', topic: '' };
}

async function detectIntent(userMessage) {
  const prompt = `Classify the user message into one intent: "weather", "news", or "general".
- If intent is "weather", extract the location (city, state, country). Use "" if no clear location.
- If intent is "news", extract the topic (e.g., "tech", "politics"). Use "" if no clear topic.
- Respond ONLY with a JSON object wrapped in \`\`\`json.
User: "${userMessage}"
Response strictly in JSON:`; //

  try {
    if (!DISABLE_GEMINI) {
        const raw = await callGemini(prompt, 'gemini-2.5-flash'); 
        const parsed = extractJson(raw);
        if (parsed && parsed.intent) {
            return {
                intent: parsed.intent.toLowerCase(),
                location: parsed.location ?? '',
                topic: parsed.topic ?? '',
            };
        }
    }
  } catch (error) {
    console.error('Gemini intent detection failed:', error.message);
  }
  return fallbackIntentDetection(userMessage); //
}

// --- WEATHER HANDLER WITH OUTDOOR ACTIVITIES ---

async function handleWeather(location) {
  if (!WEATHER_API_KEY) return 'Weather service is not configured yet. Please add WEATHER_API_KEY.'; //
  if (!location) return 'Please provide a location so I can look up the weather for you.'; //

  try {
    const forecastEndpoint = 'https://api.weatherapi.com/v1/forecast.json'; //
    const { data: weatherData } = await http.get(forecastEndpoint, {
      params: {
        key: WEATHER_API_KEY,
        q: location,
        days: 1, 
        aqi: 'no',
        alerts: 'no',
      },
    });

    const loc = weatherData.location;
    const locationName = [loc?.name, loc?.region, loc?.country].filter(Boolean).join(', ') || location; //
    const current = weatherData.current;
    
    // Formatting weather data string
    const tempText = `${current.temp_c}°C`;
    const conditionText = current?.condition?.text ?? 'N/A';
    const humidityText = `${current.humidity}%`;
    const windText = `${current.wind_kph} km/h`;

    let response = `**Weather for ${locationName}**\n`; //
    response += `**Condition:** ${conditionText}\n`;
    response += `🌡️ **Temp:** ${tempText} (Feels like: ${current.feelslike_c}°C)\n`; //
    response += `💧 **Humidity:** ${humidityText}\n`;
    response += `💨 **Wind:** ${windText}\n`;

    // --- NEW: GENERATE OUTDOOR ACTIVITIES ---
    if (!DISABLE_GEMINI) {
        try {
            const activityPrompt = `Based on the current weather in ${locationName} (${conditionText}, ${tempText}, Wind: ${windText}), suggest 3 specific outdoor activities suitable for right now. If the weather is bad (heavy rain, storm, extreme heat), suggest indoor alternatives or "caution". Keep it brief and bulleted.`;
            const activities = await callGemini(activityPrompt, 'gemini-2.5-flash');
            response += `\n**🏃 Suggested Activities:**\n${activities.trim()}`;
        } catch (actError) {
            console.warn('Failed to generate activities:', actError.message);
        }
    }
    return response;

  } catch (error) {
    console.error('Weather API error:', error.message);
    if (error.response?.status === 400) {
      return `I couldn't find weather information for "${location}". Please check the spelling.`; //
    }
    return 'Sorry, I encountered an issue while trying to retrieve the weather information.'; //
  }
}

// --- NEWS HANDLER ---

function extractNewsKeywords(text) {
    if (!text) return ''; //
    const lower = text.toLowerCase();
    const blacklist = new Set(['news','headline','headlines','top','latest','get','me','what','about','on','regarding','update']); //
    return lower.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !blacklist.has(w) && w.length > 2).slice(0, 5).join(' '); //
}

async function handleNews(topic, originalMessage) {
    if (!NEWS_API_KEY) return 'News service is not configured yet.';

    // 1. Check if user wants "MORE" news (Pagination Logic)
    let page = 1;
    if (originalMessage.toLowerCase().includes('more')) {
        page = 2; // If user says "more", we fetch the next page of results
    }

    // 2. Extract Keywords
    const blacklist = new Set(['news','headline','headlines','top','latest','get','me','what','about','on','regarding','update', 'for', 'in', 'show', 'more']);
    const lower = (topic || originalMessage || '').toLowerCase();
    const derivedKeywords = lower.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !blacklist.has(w) && w.length > 2).slice(0, 5).join(' ');

    let endpoint = 'https://newsapi.org/v2/everything';
    let params = { 
        pageSize: 5, 
        page: page, // <--- Uses the page detected above
        language: 'en', 
        sortBy: 'publishedAt' // Shows newest first
    }; 
    
    if (derivedKeywords) {
        params.q = derivedKeywords;
    } else {
        endpoint = 'https://newsapi.org/v2/top-headlines';
        params = { country: 'us', category: 'general', pageSize: 5, page: page }; 
    }

    try {
        const { data } = await http.get(endpoint, { params, headers: { 'X-Api-Key': NEWS_API_KEY } });
        
        if (!data.articles?.length) return page > 1 ? "I couldn't find any *more* news on that topic." : "I couldn't find any recent news articles.";
        
        const articles = data.articles.map((a, i) => `**${i+1}. ${a.title}**\n   📰 _${a.source?.name}_ • ${new Date(a.publishedAt).toLocaleDateString()}\n   🔗 [Read more](${a.url})`).join('\n\n');
        
        const titlePrefix = page > 1 ? "More Headlines" : "Headlines";
        return `**📰 ${titlePrefix}: ${derivedKeywords || "Top Stories"}**\n\n${articles}`;
    } catch (error) {
        return 'Sorry, I had trouble fetching the news.';
    }
}

// --- ANALYSIS HELPERS ---

async function analyzeSarcasm(userMessage) {
  const prompt = `Analyze for sarcasm. Return JSON: {"is_sarcastic": bool, "literal_meaning": "string", "intended_meaning": "string"}. Message: "${userMessage}"`; //
  try {
    const raw = await callGemini(prompt); 
    return extractJson(raw); 
  } catch (error) { return null; }
}

async function analyzeSentiment(userMessage) {
  const prompt = `Analyze sentiment. Respond JSON: {"is_low_mood": true/false}. Message: "${userMessage}"`; //
  try {
    if (!DISABLE_GEMINI) {
        const raw = await callGemini(prompt);
        return extractJson(raw);
    }
    return { is_low_mood: false };
  } catch { return { is_low_mood: false }; }
}

async function getGitaSupport(userMessage) {
  const prompt = `You are a wise spiritual guide. Provide a relevant Bhagavad Gita Shloka for: "${userMessage}". JSON: {"sanskrit": "...", "english_transliteration": "...", "meaning": "..."}`; //
  try {
    if (!DISABLE_GEMINI) {
       const raw = await callGemini(prompt);
       return extractJson(raw); 
    }
    return null;
  } catch { return null; }
}


async function handleGeneralResponse(userMessage, sessionId) {
  let sarcasmResult = null;
  let sentimentResult = null;

  if (!DISABLE_GEMINI) {
    try {
      [sarcasmResult, sentimentResult] = await Promise.all([
          analyzeSarcasm(userMessage),
          analyzeSentiment(userMessage) //
      ]);
    } catch (e) { console.error("Analysis tasks failed:", e.message); }
  }

  // GITA INTERVENTION
  if (sentimentResult?.is_low_mood) {
    const gita = await getGitaSupport(userMessage); //
    if (gita) return `I sense you're feeling down. Here is wisdom from the Gita:\n\n**${gita.sanskrit}**\n*${gita.english_transliteration}*\n\n${gita.meaning}`; //
  }

  let systemInstruction = `You are NodeMesh, a helpful AI assistant. Answer concisely.`; //
  if (sarcasmResult?.is_sarcastic) {
    systemInstruction += `\n[TONE: SARCASTIC] The user meant: "${sarcasmResult.intended_meaning}". Respond to that.`; //
  }

  // RETRIEVE AND USE HISTORY
  const history = getSessionHistory(sessionId);
  const contextPrompt = `${systemInstruction}\nUser message: "${userMessage}"`;

  try {
    if (DISABLE_GEMINI) throw new Error('Gemini disabled'); //
    const response = await callGemini(contextPrompt, GEMINI_MODEL, history, 100);
    return response.trim();
  } catch (error) {
    return "I'm having trouble thinking right now. Try asking for weather or news."; //
  }
}

// --- MAIN CHAT ENDPOINT ---

app.post('/chat', async (req, res) => {
  const { message, sessionId: providedSessionId } = req.body;
  
  // Use provided sessionId or generate a temporary one (stateless fallback)
  const sessionId = providedSessionId || 'default-session';

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' }); //
  }

  try {
    // 1. Detect Intent
    const { intent, location, topic } = await detectIntent(message);
    let reply = "Sorry, Gemini RATE LIMIT HIT."; 

    // 2. Route Request
    if (intent === 'weather') {
      reply = await handleWeather(location);
    } else if (intent === 'news') {
      reply = await handleNews(topic, message);
    } else {
      reply = await handleGeneralResponse(message, sessionId);
    }

    // 3. Update History
    updateSessionHistory(sessionId, 'user', message);
    updateSessionHistory(sessionId, 'model', reply);

    return res.json({ reply, intent, location, topic, sessionId });

  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: 'Something went wrong.' }); //
  }
});

// --- HEALTH CHECKS ---
app.get('/', (_req, res) => res.type('text/plain').send('NodeMesh Chat Backend OK')); //
app.get('/healthz', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() })); //

app.listen(PORT, '0.0.0.0', () => { 
  console.log(`Server listening on port ${PORT}`); //
  console.log(`Using Gemini Model: ${GEMINI_MODEL}`); //
});
