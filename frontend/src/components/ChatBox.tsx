import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User } from 'lucide-react';
import { chatWithAI } from '../api/client';
import type { ChatMessage } from '../types';

interface ChatBoxProps {
  contextType?: string;
  isLoggedIn?: boolean;
}

export const ChatBox = ({ contextType, isLoggedIn = true }: ChatBoxProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    setMessages([]);
  }, [contextType]);

  const handleSend = async (): Promise<void> => {
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

  const renderInline = (text: string): Array<string | JSX.Element> => {
    return text.split(/(\*\*.*?\*\*)/g).map((part, index) => {
      const match = part.match(/^\*\*(.*?)\*\*$/);
      if (!match) return part;
      return <strong key={`${index}-${match[1]}`}>{match[1]}</strong>;
    });
  };

  const formatMessage = (text: string): JSX.Element[] => {
    return text.split('\n').map((line, index) => {
      if (!line) {
        return <span key={index} className="block">{'\u00a0'}</span>;
      }

      const numbered = line.match(/^(\d+)\.\s(.*)$/);
      if (numbered) {
        return (
          <span key={`${index}-${line}`} className="block">
            <span className="text-primary font-semibold">{numbered[1]}.</span>{' '}
            {renderInline(numbered[2])}
          </span>
        );
      }

      if (line.startsWith('- ') || line.startsWith('* ')) {
        return (
          <span key={`${index}-${line}`} className="block">
            {'\u2022 '}
            {renderInline(line.slice(2))}
          </span>
        );
      }

      return <span key={`${index}-${line}`} className="block">{renderInline(line)}</span>;
    });
  };

  return (
    <div className="card bg-base-200 overflow-hidden flex flex-col">
      <div className="px-4 py-2.5 border-b border-base-300 flex items-center gap-2">
        <Bot size={16} className="text-primary" />
        <span className="text-sm font-semibold">AI Assistant</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[360px]">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Bot size={28} className="opacity-20 mb-2" />
            <p className="text-xs opacity-40">
              {isLoggedIn
                ? 'Ask me anything about your fantasy team, player stats, or trade advice.'
                : 'Sign in to chat with the AI assistant.'}
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex items-start gap-2 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                msg.role === 'user' ? 'bg-primary' : 'bg-base-300 border border-base-content/10'
              }`}>
                {msg.role === 'user'
                  ? <User size={12} className="text-primary-content" />
                  : <Bot size={12} className="text-primary" />}
              </div>
              <div className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-primary text-primary-content rounded-tr-sm'
                  : 'bg-base-300 rounded-tl-sm'
              }`}>
                {msg.role === 'assistant' ? formatMessage(msg.message) : msg.message}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center flex-shrink-0">
                <Bot size={12} className="text-primary" />
              </div>
              <div className="bg-base-300 rounded-xl rounded-tl-sm px-4 py-3">
                <span className="loading loading-dots loading-sm" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="px-3 py-2.5 border-t border-base-300 bg-base-300/50">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={isLoggedIn ? 'Ask the AI assistant...' : 'Sign in to chat...'}
            className="input input-bordered input-sm flex-1"
            disabled={loading || !isLoggedIn}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim() || !isLoggedIn}
            className="btn btn-primary btn-sm btn-square"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};
