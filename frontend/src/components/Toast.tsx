import { useEffect } from 'react';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

export type ToastVariant = 'success' | 'error';

interface ToastProps {
  message: string;
  variant?: ToastVariant;
  onDismiss: () => void;
  /** Auto-dismiss after this many milliseconds. Defaults to 2500. */
  duration?: number;
}

/**
 * Bottom-right toast notification. Self-dismisses after `duration` ms,
 * or immediately on click. Pure inline component — no library needed.
 */
export const Toast = ({ message, variant = 'success', onDismiss, duration = 2500 }: ToastProps) => {
  useEffect(() => {
    const id = setTimeout(onDismiss, duration);
    return () => clearTimeout(id);
  }, [duration, onDismiss]);

  const bg = variant === 'success' ? 'bg-emerald-500' : 'bg-red-500';
  const Icon = variant === 'success' ? CheckCircle2 : AlertTriangle;

  return (
    <div className="fixed bottom-6 right-6 z-[100] animate-[slideUp_0.2s_ease-out]">
      <div className={`${bg} text-white rounded-lg shadow-2xl px-4 py-3 flex items-center gap-3 min-w-[260px] max-w-md`}>
        <Icon size={18} className="flex-shrink-0" />
        <span className="text-sm font-medium flex-1">{message}</span>
        <button
          onClick={onDismiss}
          className="opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
