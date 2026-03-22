import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { chatWithAI } from '../api/client';
import type { ChatMessage } from '../types';

interface ChatBoxProps {
  contextType?: string;
}

export default function ChatBox({ contextType }: ChatBoxProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Reset messages when context changes
  useEffect(() => {
    setMessages([]);
  }, [contextType]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: 'user', message: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    try {
      const { reply } = await chatWithAI(text, contextType, updatedMessages);
      setMessages([...updatedMessages, { role: 'assistant', message: reply }]);
    } catch {
      setMessages([
        ...updatedMessages,
        { role: 'assistant', message: 'Sorry, I encountered an error. Please try again.' },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const formatMessage = (text: string) => {
    // Simple markdown-like formatting
    return text.split('\n').map((line, i) => {
      // Bold
      let formatted = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Bullet points
      if (formatted.startsWith('- ') || formatted.startsWith('* ')) {
        formatted = '&bull; ' + formatted.slice(2);
      }
      // Numbered lists
      formatted = formatted.replace(/^(\d+)\.\s/, '<span class="text-[#3b82f6] font-semibold">$1.</span> ');

      return (
        <span key={i} className="block" dangerouslySetInnerHTML={{ __html: formatted || '&nbsp;' }} />
      );
    });
  };

  return (
    <div className="bg-[#1a1d29] rounded-xl border border-[#2a2d3a] overflow-hidden flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-[#2a2d3a] flex items-center gap-2">
        <Bot size={16} className="text-[#3b82f6]" />
        <span className="text-sm font-semibold text-white">AI Assistant</span>
        {contextType && (
          <span className="text-[10px] text-[#6b7280] bg-[#252836] px-2 py-0.5 rounded-full">
            {contextType}
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[360px]">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Bot size={28} className="text-[#3b3f51] mb-2" />
            <p className="text-xs text-[#6b7280]">
              Ask me anything about your fantasy team, player stats, or trade advice.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`flex items-start gap-2 max-w-[85%] ${
                msg.role === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  msg.role === 'user'
                    ? 'bg-[#3b82f6]'
                    : 'bg-[#252836] border border-[#2a2d3a]'
                }`}
              >
                {msg.role === 'user' ? (
                  <User size={12} className="text-white" />
                ) : (
                  <Bot size={12} className="text-[#3b82f6]" />
                )}
              </div>
              <div
                className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-[#3b82f6] text-white rounded-tr-sm'
                    : 'bg-[#252836] text-[#d1d5db] rounded-tl-sm border border-[#2a2d3a]'
                }`}
              >
                {msg.role === 'assistant' ? formatMessage(msg.message) : msg.message}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-[#252836] border border-[#2a2d3a] flex items-center justify-center flex-shrink-0">
                <Bot size={12} className="text-[#3b82f6]" />
              </div>
              <div className="bg-[#252836] rounded-xl rounded-tl-sm border border-[#2a2d3a] px-4 py-3">
                <Loader2 size={16} className="text-[#3b82f6] animate-spin" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-2.5 border-t border-[#2a2d3a] bg-[#151822]">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask the AI assistant..."
            className="flex-1 bg-[#1a1d29] border border-[#2a2d3a] rounded-lg px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:outline-none focus:border-[#3b82f6] transition-colors"
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="p-2 rounded-lg bg-[#3b82f6] text-white hover:bg-[#2563eb] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
