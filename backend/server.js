import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

dotenv.config();
const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- MEMORY STORAGE ---
const sessionStore = new Map();
const MAX_HISTORY_TURNS = 6; // Stores last 6 turns (12 messages) 

function getSessionHistory(sessionId) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, []);
  }
  return sessionStore.get(sessionId);
}

function updateSessionHistory(sessionId, role, content) {
  const history = getSessionHistory(sessionId);
  history.push({ role, content });
  
  // Maintain sliding window 
  if (history.length > MAX_HISTORY_TURNS * 2) {
    sessionStore.set(sessionId, history.slice(-(MAX_HISTORY_TURNS * 2)));
  }
}

// --- CHAT HANDLER ---
async function handleChat(message, sessionId) {
  const history = getSessionHistory(sessionId);
  
  // Determine if the user wants an essay or elaboration
  const isDetailedRequest = /elaborate|essay|detailed|explain in depth/i.test(message);
  
  const systemInstruction = isDetailedRequest 
    ? "You are a detailed assistant. Provide in-depth explanations or essays as requested."
    : "You are NodeMesh. Answer in a short, crisp, and concise form. Limit your response to 200 words.";

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemInstruction },
        ...history,
        { role: "user", content: message }
      ],
      model: "llama-3.3-70b-versatile",
      max_tokens: isDetailedRequest ? 300 : 150, 
    });

    const reply = completion.choices[0]?.message?.content;
    
    // Save to memory
    updateSessionHistory(sessionId, "user", message);
    updateSessionHistory(sessionId, "assistant", reply);

    return reply;
  } catch (error) {
    console.error("Groq Error:", error);
    return "I'm having trouble accessing our previous context. Note: Chats are only stored up to the last 6 messages for context building.";
  }
}

app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;
  const reply = await handleChat(message, sessionId);
  res.json({ reply });
});

app.listen(process.env.PORT || 3001);
