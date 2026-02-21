import { useState, useRef, useEffect } from "react";
import "./App.css";
import axios from "axios";
import ChatBubble from "./ChatBubble"; 
import TypingIndicator from "./TypingIndicator";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

function App() {
  const [darkMode, setDarkMode] = useState(() => {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return true;
    }
    return false;
  });

  const [chatHistory, setChatHistory] = useState([]);
  const [question, setQuestion] = useState("");
  const [generatingAnswer, setGeneratingAnswer] = useState(false);
  const [showScrollArrow, setShowScrollArrow] = useState(false);
  
  const chatContainerRef = useRef(null);
  const abortControllerRef = useRef(null); 

  // Auto-scroll logic
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatHistory, generatingAnswer]);

  // Scroll listener to show/hide jump arrow
  const handleScroll = () => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      // Show arrow if user is more than 300px away from bottom
      const isNearBottom = scrollHeight - scrollTop <= clientHeight + 300;
      setShowScrollArrow(!isNearBottom);
    }
  };

  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
  };

  // Function to stop generation
  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setGeneratingAnswer(false);
    }
  };

  async function generateAnswer(e) {
    e.preventDefault();
    if (!question.trim()) return;

    // Initialize AbortController
    abortControllerRef.current = new AbortController();
    
    setGeneratingAnswer(true);
    const currentQuestion = question;
    setQuestion(""); 

    const historyContext = chatHistory.slice(-6).map(msg => ({
      role: msg.type === 'question' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    setChatHistory(prev => [...prev, { type: 'question', content: currentQuestion }]);

    try {
      const response = await axios.post(`${API_BASE_URL}/chat`, { 
        message: currentQuestion,
        history: historyContext
      }, {
        signal: abortControllerRef.current.signal // Attach signal to request
      });
      
      const aiResponse = response.data.reply;
      setChatHistory(prev => [...prev, { type: 'answer', content: aiResponse }]);
      
    } catch (error) {
      if (axios.isCancel(error)) {
        setChatHistory(prev => [...prev, { type: 'answer', content: "_Generation stopped by user._" }]);
      } else {
        console.error("Error:", error.response?.data || error.message);
        const errorMessage = "Sorry - Something went wrong connecting to the server.";
        setChatHistory(prev => [...prev, { type: 'answer', content: errorMessage }]);
      }
    } finally {
      setGeneratingAnswer(false);
      abortControllerRef.current = null;
    }
  }

  return (
    <div className={`fixed inset-0 transition-colors duration-500 ${darkMode ? 'bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900' : 'bg-gradient-to-r from-blue-50 to-blue-100'}`}>
      <div className="h-full max-w-4xl mx-auto flex flex-col p-3 relative">
        
        {/* Header */}
        <header className="flex items-center justify-between py-4">
          <a href="https://github.com/ANKVIT26" target="_blank" rel="noopener noreferrer" className="block">
            <h1 className={`text-4xl font-bold transition-colors ${darkMode ? 'text-cyan-300 hover:text-cyan-400' : 'text-blue-500 hover:text-blue-600'}`}>NodeMesh AI</h1>
          </a>
          <button
            className={`ml-4 px-4 py-2 rounded-lg font-semibold shadow-md transition-all duration-200 focus:outline-none darkmode-toggle ${darkMode ? 'bg-gray-700 text-cyan-200 hover:bg-gray-600' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'}`}
            onClick={() => setDarkMode((d) => !d)}
            type="button"
          >
            {darkMode ? '🌙 Dark' : '☀️ Light'}
          </button>
        </header>

        {/* Scrollable Chat Container */}
        <div 
          ref={chatContainerRef}
          onScroll={handleScroll}
          className={`flex-1 overflow-y-auto mb-4 rounded-lg shadow-lg p-4 hide-scrollbar transition-colors duration-500 relative ${darkMode ? 'bg-gray-800' : 'bg-white'}`}
        >
          {chatHistory.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6">
              <div className={`rounded-xl p-8 max-w-2xl shadow-md ${darkMode ? 'bg-gray-900' : 'bg-blue-50'}`}> 
                <h2 className={`text-2xl font-bold mb-4 ${darkMode ? 'text-cyan-300' : 'text-blue-600'}`}>Welcome to NodeMesh AI! 👋</h2>
                <p className={`mb-4 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}> 
                  I'm here to help you with anything you'd like to know.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left">
                  <div className={`p-4 rounded-lg shadow-sm ${darkMode ? 'bg-gray-800 text-cyan-200' : 'bg-white text-blue-700'}`}> <span className="text-blue-500">💡</span> Intent Based </div>
                  <div className={`p-4 rounded-lg shadow-sm ${darkMode ? 'bg-gray-800 text-cyan-200' : 'bg-white text-blue-700'}`}> <span className="text-blue-500">🔧</span> Bhagwad Gita Shloks </div>
                  <div className={`p-4 rounded-lg shadow-sm ${darkMode ? 'bg-gray-800 text-cyan-200' : 'bg-white text-blue-700'}`}> <span className="text-blue-500">📝</span> General knowledge </div>
                  <div className={`p-4 rounded-lg shadow-sm ${darkMode ? 'bg-gray-800 text-cyan-200' : 'bg-white text-blue-700'}`}> <span className="text-blue-500">🤔</span> Sarcasm Friendly </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col space-y-2">
              {chatHistory.map((chat, index) => (
                <ChatBubble 
                  key={index}
                  message={chat.content}
                  isUser={chat.type === 'question'}
                />
              ))}
              {generatingAnswer && (
                <div className="flex justify-start mt-2 animate-fade-in">
                  <TypingIndicator />
                </div>
              )}
            </div>
          )}

          {/* Jump to Bottom Arrow */}
          {showScrollArrow && (
            <button 
              onClick={scrollToBottom}
              className={`fixed bottom-28 right-8 md:right-1/4 p-3 rounded-full shadow-2xl transition-all duration-300 z-50 jump-arrow ${darkMode ? 'bg-cyan-600 text-white' : 'bg-blue-500 text-white'}`}
            >
              ↓
            </button>
          )}
        </div>

        {/* Fixed Input Form */}
        <form onSubmit={generateAnswer} className={`rounded-lg shadow-lg p-4 transition-colors duration-500 ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
          <div className="flex gap-2 items-center">
            <textarea
              required
              disabled={generatingAnswer}
              className={`flex-1 border rounded p-3 focus:ring-2 resize-none transition-colors duration-200 ${darkMode ? 'bg-gray-800 border-gray-700 text-cyan-100 focus:border-cyan-400 focus:ring-cyan-400 placeholder-gray-400' : 'border-gray-300 focus:border-blue-400 focus:ring-blue-400'} ${generatingAnswer ? 'opacity-50' : ''}`}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask anything..."
              rows="1"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!generatingAnswer) generateAnswer(e);
                }
              }}
            ></textarea>
            
            {generatingAnswer ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="px-4 py-2 bg-red-500 text-white font-bold rounded-md hover:bg-red-600 transition-colors flex items-center justify-center"
                title="Stop Generating"
              >
                <div className="w-3 h-3 bg-white rounded-sm"></div> {/* Stop Square icon */}
              </button>
            ) : (
              <button
                type="submit"
                className={`px-6 py-2 font-semibold rounded-md shadow-md transition-all duration-200 transform hover:scale-105 focus:outline-none send-btn ${darkMode ? 'bg-cyan-700 text-white hover:bg-cyan-800' : 'bg-blue-500 text-white hover:bg-blue-600'}`}
              >
                Send
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default App;
