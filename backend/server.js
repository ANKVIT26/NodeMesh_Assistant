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

// --- SECURITY MIDDLEWARE ---
app.use(helmet()); // Sets secure HTTP headers
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per window
});
app.use('/chat', limiter);

// --- API INITIALIZATION ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// --- SECURE CORS ---
const allowedOrigins = ['https://nodemesh-ai-frontend.onrender.com', 'http://localhost:5173'];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// --- RESILIENT WEATHER HANDLER ---
// Added coordinate support and automatic retries to prevent "frequent falls"
async function handleWeather(location) {
  if (!WEATHER_API_KEY) return "Weather config missing.";
  
  const endpoints = [
    `https://api.weatherapi.com/v1/current.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(location)}`,
    `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(location)}&days=1`
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, { timeout: 8000 });
      const { temp_c, condition, humidity } = data.current;
      return `The weather in ${data.location.name} is ${condition.text} at ${temp_c}°C with ${humidity}% humidity.`;
    } catch (err) {
      console.error(`Weather attempt failed: ${err.message}`);
      // Continue to next endpoint or return error if last
    }
  }
  return "I'm having trouble reaching the weather service. Please try a specific city name.";
}

// --- UPDATED GROQ CHAT LOGIC ---
async function handleGeneralResponse(message, history = []) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: "You are NodeMesh, a helpful AI. Be concise." },
        ...history,
        { role: "user", content: message }
      ],
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0]?.message?.content || "No response generated.";
  } catch (error) {
    console.error('Groq Error:', error.message);
    return "AI service is currently busy. Please try again in a moment.";
  }
}

// --- MAIN CHAT ENDPOINT ---
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  try {
    // Intent Detection using Groq (Faster & more accurate than regex)
    const intentPrompt = `Classify intent: "weather", "news", or "general". 
    If weather, extract location. Format: JSON {"intent": "", "location": ""}. 
    Message: "${message}"`;
    
    const intentResponse = await handleGeneralResponse(intentPrompt);
    const { intent, location } = JSON.parse(intentResponse.match(/{.*?}/s)[0] || '{"intent":"general"}');

    let reply;
    if (intent === 'weather') {
      reply = await handleWeather(location || message);
    } else {
      reply = await handleGeneralResponse(message);
    }

    res.json({ reply, intent });
  } catch (error) {
    res.status(500).json({ error: "Processing failed" });
  }
});

app.listen(PORT, () => console.log(`Secure server on port ${PORT}`));
