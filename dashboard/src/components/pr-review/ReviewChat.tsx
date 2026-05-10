/** Right rail review chat: loads transcript on mount, posts new turns, and renders
 *  user/assistant pairs with an optional annotation attachment chip on the composer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import {
  fetchReviewChat,
  sendReviewChatMessage,
} from "@dashboard/lib/api/pr-sessions";
import { cn, filenameTail } from "@dashboard/lib/utils";
import { Markdown } from "@dashboard/components/Markdown";
import { UnicodeSpinner } from "@dashboard/components/UnicodeSpinner";
import { useElapsedSeconds } from "@dashboard/hooks/use-elapsed-seconds";
import type {
  PrReviewAnnotation,
  PrSessionMode,
  ReviewChatMessage,
} from "@dashboard/shared";

interface ReviewChatProps {
  sessionId: string;
  mode: PrSessionMode;
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
    <div className="flex h-full flex-col">
      <ChatBody messages={messages} pending={pending} unavailableReason={unavailableReason} />
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

// --- Body ---

interface ChatBodyProps {
  messages: ReviewChatMessage[];
  pending: boolean;
  unavailableReason: string | null;
}

function ChatBody({ messages, pending, unavailableReason }: ChatBodyProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending]);

  if (unavailableReason) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center">
        <p className="font-mono text-[11px] text-text-secondary">{unavailableReason}</p>
      </div>
    );
  }

  if (messages.length === 0 && !pending) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-ghost">
            <ArrowUp className="h-4 w-4 text-accent opacity-60" />
          </div>
          <p className="font-mono text-[11px] leading-relaxed text-text-secondary">
            Ask a question or hit Reply on an annotation to start.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-4 pt-4 scroll-smooth"
    >
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
        <div className="flex max-w-[85%] flex-col gap-[6px]">
          {annotation && annotation.type === "annotation" && (
            <AnnotationChip annotation={annotation.annotation} compact />
          )}
          <div className="rounded-2xl rounded-br-md bg-accent/15 px-3 py-2">
            <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6] text-text">{text}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[95%]">
      <Markdown
        content={text}
        className="font-mono text-[11px] leading-[1.65] prose-p:text-text-secondary prose-li:text-text-secondary prose-strong:text-text prose-code:text-[10px]"
      />
    </div>
  );
}

function WorkerBubble() {
  const seconds = useElapsedSeconds();
  const verb = WORKER_VERBS[Math.floor(seconds / 4) % WORKER_VERBS.length];
  return (
    <div className="flex items-center gap-[10px] text-text-ghost">
      <UnicodeSpinner name="sparkle" className="text-[14px]" />
      <span className="font-mono text-[10px] text-text-secondary">
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
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const canSend = !disabled && input.trim().length > 0;

  return (
    <footer className="shrink-0 px-3 pb-3 pt-2">
      {attachedAnnotation && (
        <div className="mb-2">
          <AnnotationChip annotation={attachedAnnotation} onRemove={onClearAnnotation} />
        </div>
      )}
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl border border-glass-border bg-field px-3 transition-all duration-200",
          "focus-within:border-accent/40 focus-within:bg-field-focus focus-within:shadow-accent-focus",
        )}
      >
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
          placeholder={disabled ? "Waiting..." : "Ask about this review..."}
          className={cn(
            "max-h-[120px] min-h-[36px] w-full resize-none bg-transparent py-[10px] pr-2",
            "font-mono text-[11px] leading-[1.6] text-text",
            "placeholder:text-text-ghost/60 focus:outline-none",
            disabled && "cursor-not-allowed opacity-50",
          )}
        />
        <button
          type="button"
          aria-label="Send message"
          disabled={!canSend}
          onClick={onSend}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all duration-200",
            canSend
              ? "bg-accent text-bg shadow-accent-button hover:shadow-accent-button-hover hover:scale-105 active:scale-95"
              : "bg-disabled text-text-ghost cursor-not-allowed",
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
  const tail = filenameTail(annotation.filePath);
  return (
    <div
      className={cn(
        "flex items-center gap-[6px] rounded-md border border-white/20 bg-bg-raised/60 px-[10px] py-[5px]",
        compact && "self-end",
      )}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary">
        {annotation.kind.replace(/_/g, " ")}
      </span>
      <span className="truncate font-mono text-[10px] text-text-dim">
        {tail}:line {annotation.line}
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
