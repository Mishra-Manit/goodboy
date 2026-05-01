/** Right rail review chat: loads transcript on mount, posts new turns, and renders
 *  user/assistant pairs with an optional annotation attachment chip on the composer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import {
  fetchReviewChat,
  sendReviewChatMessage,
} from "@dashboard/lib/api/pr-sessions";
import { cn } from "@dashboard/lib/utils";
import { Markdown } from "@dashboard/components/Markdown";
import { UnicodeSpinner } from "@dashboard/components/UnicodeSpinner";
import type {
  PrReviewAnnotation,
  PrSessionMode,
  ReviewChatMessage,
} from "@dashboard/shared";

interface ReviewChatProps {
  sessionId: string;
  mode: PrSessionMode;
  prNumber: number | null;
  branch: string | null;
  activeFile: string | null;
  attachedAnnotation: PrReviewAnnotation | null;
  onClearAnnotation: () => void;
  onChanged: () => void;
}

const WORKER_VERBS = ["boliviating", "pondering", "patching", "pushing"] as const;

export function ReviewChat({
  sessionId,
  mode,
  activeFile,
  attachedAnnotation,
  onClearAnnotation,
  onChanged,
}: ReviewChatProps) {
  const [messages, setMessages] = useState<ReviewChatMessage[]>([]);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);

  const available = mode === "review" && unavailableReason === null;

  useEffect(() => {
    let cancelled = false;
    if (mode !== "review") {
      setUnavailableReason("Review chat is available for reviewed PRs only.");
      setMessages([]);
      return;
    }
    fetchReviewChat(sessionId)
      .then((res) => {
        if (cancelled) return;
        setUnavailableReason(res.available ? null : res.reason);
        setMessages(res.messages);
      })
      .catch(() => {
        if (cancelled) return;
        setUnavailableReason("Could not load review chat.");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, mode]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || pending || !available) return;

    const optimisticUser = optimisticUserMessage(text, attachedAnnotation);
    setMessages((prev) => [...prev, optimisticUser]);
    setInput("");
    onClearAnnotation();
    setPending(true);

    try {
      const res = await sendReviewChatMessage(sessionId, {
        message: text,
        activeFile,
        annotation: attachedAnnotation,
      });
      setMessages(res.messages);
      if (res.changed) onChanged();
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `${optimisticUser.id}-error`,
          role: "assistant",
          parts: [{ type: "text", text: "Couldn't finish. Check transcript." }],
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setPending(false);
    }
  }, [input, pending, available, attachedAnnotation, sessionId, activeFile, onClearAnnotation, onChanged]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <ChatHeader />
      <ChatBody messages={messages} pending={pending} unavailableReason={mode !== "review" ? null : unavailableReason} />
      <Composer
        input={input}
        onInput={setInput}
        onSend={send}
        disabled={!available || pending}
        attachedAnnotation={attachedAnnotation}
        onClearAnnotation={onClearAnnotation}
      />
    </div>
  );
}

// --- Header ---

function ChatHeader() {
  return (
    <header className="flex items-center border-b border-glass-border px-[18px] py-[14px]">
      <h2 className="min-w-0 truncate font-display text-[12px] font-medium text-text">
        Review thread
      </h2>
    </header>
  );
}

// --- Body ---

interface ChatBodyProps {
  messages: ReviewChatMessage[];
  pending: boolean;
  unavailableReason: string | null;
}

function ChatBody({ messages, pending, unavailableReason }: ChatBodyProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, pending]);

  if (unavailableReason) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="font-body text-[12px] text-text-secondary">{unavailableReason}</p>
      </div>
    );
  }

  if (messages.length === 0 && !pending) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="font-body text-[12px] text-text-secondary">
          Ask a question or hit Reply on an annotation to start.
        </p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-5 pb-4 pt-5">
      {messages.map((m) => <Message key={m.id} message={m} />)}
      {pending && <WorkerBubble />}
    </div>
  );
}

function Message({ message }: { message: ReviewChatMessage }) {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const annotation = message.parts.find((p) => p.type === "annotation");

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[280px] flex-col gap-[6px]">
          {annotation && annotation.type === "annotation" && (
            <AnnotationChip annotation={annotation.annotation} compact />
          )}
          <div className="rounded-lg bg-info-dim px-3 py-2">
            <p className="whitespace-pre-wrap break-words font-body text-[12px] leading-[1.6] text-text">{text}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Markdown
      content={text}
      className="font-body text-[12px] leading-[1.65] prose-p:text-text prose-li:text-text prose-strong:text-text prose-code:text-[11px]"
    />
  );
}

function WorkerBubble() {
  const seconds = useElapsedSeconds();
  const verb = WORKER_VERBS[Math.floor(seconds / 4) % WORKER_VERBS.length];
  return (
    <div className="flex items-center gap-[10px] text-text-ghost">
      <UnicodeSpinner name="sparkle" className="text-[14px]" />
      <span className="font-body text-[11px] text-text-secondary">
        {verb}… · {seconds}s
      </span>
    </div>
  );
}

// --- Composer ---

interface ComposerProps {
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  attachedAnnotation: PrReviewAnnotation | null;
  onClearAnnotation: () => void;
}

function Composer({ input, onInput, onSend, disabled, attachedAnnotation, onClearAnnotation }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);
  return (
    <footer className="flex flex-col gap-[10px] border-t border-glass-border px-4 py-[12px]">
      {attachedAnnotation && (
        <AnnotationChip annotation={attachedAnnotation} onRemove={onClearAnnotation} />
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        disabled={disabled}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={disabled ? "…" : "Ask, or request a change"}
        className={cn(
          "max-h-[160px] w-full resize-none overflow-y-auto bg-transparent font-body text-[12px] leading-[1.6] text-text placeholder:text-text-void focus:outline-none",
          disabled && "cursor-not-allowed",
        )}
      />
      <div className="flex items-center justify-end">
        <button
          type="button"
          aria-label="Send"
          disabled={disabled || input.trim().length === 0}
          onClick={onSend}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md bg-accent text-bg transition-opacity",
            (disabled || input.trim().length === 0) ? "opacity-40" : "hover:opacity-90",
          )}
        >
          <ArrowUp className="h-[14px] w-[14px]" strokeWidth={2.5} />
        </button>
      </div>
    </footer>
  );
}

interface AnnotationChipProps {
  annotation: PrReviewAnnotation;
  onRemove?: () => void;
  compact?: boolean;
}

function AnnotationChip({ annotation, onRemove, compact }: AnnotationChipProps) {
  const sideMark = annotation.side === "old" ? "−" : "+";
  const tail = filenameTail(annotation.filePath);
  return (
    <div
      className={cn(
        "flex items-center gap-[6px] rounded-md border border-glass-border bg-bg-raised/60 px-[8px] py-[4px]",
        compact && "self-end",
      )}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary">
        {annotation.kind.replace(/_/g, " ")}
      </span>
      <span className="truncate font-mono text-[10px] text-text-dim">
        {tail}:{sideMark}{annotation.line}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label="Remove annotation"
          onClick={onRemove}
          className="ml-auto text-text-void hover:text-text"
        >
          <X className="h-[12px] w-[12px]" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

function filenameTail(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

// --- Helpers ---

function optimisticUserMessage(message: string, annotation: PrReviewAnnotation | null): ReviewChatMessage {
  const parts: ReviewChatMessage["parts"] = [{ type: "text", text: message }];
  if (annotation) parts.push({ type: "annotation", annotation });
  return {
    id: `optimistic-${Date.now()}`,
    role: "user",
    parts,
    createdAt: new Date().toISOString(),
  };
}

function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    const start = Date.now();
    const interval = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);
  return seconds;
}
