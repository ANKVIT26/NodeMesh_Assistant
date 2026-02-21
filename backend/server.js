import express from 'express';
import cors from 'cors'; 
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- SERVER TRUST & SECURITY ---
app.set('trust proxy', 1); 

app.use(helmet()); //
app.use(express.json());

// --- CORS CONFIGURATION ---
// Restrict origins to your frontend domain for better security
const allowedOrigins = ['https://nodemesh-ai-frontend.onrender.com', 'http://localhost:5173'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// --- RATE LIMITING ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, //
  message: { reply: "Too many requests. Please try again later." }
});
app.use('/chat', limiter);

// --- API & MEMORY ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
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

// --- CHAT HANDLER ---
async function handleChat(message, sessionId) {
  const history = getSessionHistory(sessionId);
  const isDetailed = /elaborate|essay|detailed|explain in depth/i.test(message);
  
  const systemInstruction = isDetailed 
    ? "Provide in-depth explanations. Be detailed." 
    : "You are NodeMesh. Answer in a short, crisp, and concise form (max 200 words).";

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemInstruction },
        ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
        { role: "user", content: message }
      ],
      model: "llama-3.3-70b-versatile",
      max_tokens: isDetailed ? 1000 : 300, 
    });

    const reply = completion.choices[0]?.message?.content;
    updateSessionHistory(sessionId, "user", message);
    updateSessionHistory(sessionId, "assistant", reply);
    return reply;
  } catch (error) {
    console.error("Groq Error:", error);
    return "I'm having trouble accessing our previous context. Note: Context is stored for the last 6 messages.";
  }
}

app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  const reply = await handleChat(message, sessionId);
  res.json({ reply });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
