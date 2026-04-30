/** Right rail: goodboy-bot review chat. Visual layout from Pencil V8 stacked diff. */

import { AtSign, Loader2, MoreHorizontal, Paperclip } from "lucide-react";

interface ReviewChatProps {
  prNumber: number | null;
  branch: string | null;
}

export function ReviewChat({ prNumber, branch }: ReviewChatProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <ChatHeader prNumber={prNumber} branch={branch} />

      <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[18px] pb-2 pt-[18px]">
        <DaySeparator label="TODAY  ·  4M" />

        <BotMessage
          time="4m"
          paragraphs={[
            { tone: "primary", text: "Took a pass at this stack — mostly clean, but I want to flag the rename in checkoutMachine." },
            { tone: "dim", text: "Anyone hydrating saved state from before this PR hits an unknown-state error and the cart silently drops. Worth widening the migration before we land it." },
          ]}
        />

        <UserMessage
          time="3m"
          name="manit"
          body="Right — do we still have anyone on the old stored shape, or is everyone past the v3 migration already?"
        />

        <BotMessage
          time="2m"
          paragraphs={[
            { tone: "primary", text: "Telemetry says about 1.4% of sessions are still on the v2 shape — small, but enough that I'd rather widen the migration than ship and watch the support queue. Happy to write it if you want." },
          ]}
        />

        <UserMessage
          time="1m"
          name="manit"
          body="Yeah go for it. Add a quick test for the v2 shape too if it's cheap."
        />

        <BotMessage
          time="now"
          paragraphs={[
            { tone: "primary", text: "Done. Added a fixture covering the v2 string-shape and a regression assert on hydrate." },
            { tone: "dim", text: "Tests pass locally — pushing the patch in a sec." },
          ]}
        />

        <TypingIndicator label="reviewing  service/payments.ts" progress="3 of 6" />
      </div>

      <Composer />
    </div>
  );
}

interface ChatHeaderProps {
  prNumber: number | null;
  branch: string | null;
}

function ChatHeader({ prNumber, branch }: ChatHeaderProps) {
  return (
    <header className="flex flex-col gap-[10px] border-b border-glass-border px-[18px] py-[14px]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-[6px] w-[6px] rounded-full bg-ok" />
          <span className="font-display text-[14px] font-medium text-text">goodboy-bot</span>
          <span className="font-mono text-[10px] text-text-ghost">online  ·  opus 4.7</span>
        </div>
        <button
          type="button"
          className="text-text-ghost transition-colors hover:text-text-secondary"
          aria-label="More"
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] text-text-ghost">
        {prNumber !== null && <span>PR #{prNumber}</span>}
        {prNumber !== null && branch && <span className="text-text-void">·</span>}
        {branch && <span className="truncate">{branch}</span>}
      </div>
    </header>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-[10px]">
      <span className="h-px flex-1 bg-glass-border opacity-40" />
      <span className="font-mono text-[9px] font-semibold tracking-[0.2em] text-text-void">
        {label}
      </span>
      <span className="h-px flex-1 bg-glass-border opacity-40" />
    </div>
  );
}

interface BotParagraph {
  tone: "primary" | "dim";
  text: string;
}

function BotMessage({ time, paragraphs }: { time: string; paragraphs: BotParagraph[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border border-accent-dim">
          <span className="font-mono text-[7.5px] font-bold tracking-[0.05em] text-accent">gb</span>
        </span>
        <span className="font-body text-[11px] font-semibold text-text">goodboy-bot</span>
        <span className="font-mono text-[11px] text-text-void">·</span>
        <span className="font-mono text-[9px] text-text-void">{time}</span>
      </div>
      <div className="flex flex-col gap-2 border-l border-glass-border pb-1 pl-[14px] pt-[2px]">
        {paragraphs.map((p, idx) => (
          <p
            key={idx}
            className={
              p.tone === "primary"
                ? "font-body text-[12.5px] leading-[1.5] text-text"
                : "font-body text-[12px] leading-[1.55] text-text-dim"
            }
          >
            {p.text}
          </p>
        ))}
      </div>
    </div>
  );
}

function UserMessage({ time, name, body }: { time: string; name: string; body: string }) {
  return (
    <div className="flex flex-col items-end gap-[6px]">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] text-text-void">{time}</span>
        <span className="font-mono text-[11px] text-text-void">·</span>
        <span className="font-body text-[11px] font-semibold text-text-dim">{name}</span>
      </div>
      <div className="max-w-[300px] rounded-lg bg-accent-ghost px-3 py-2">
        <p className="font-body text-[12px] leading-[1.5] text-text">{body}</p>
      </div>
    </div>
  );
}

function TypingIndicator({ label, progress }: { label: string; progress: string }) {
  return (
    <div className="flex items-center gap-2 py-[2px] font-mono text-[10px] text-text-dim">
      <Loader2 className="h-[10px] w-[10px] animate-spin text-accent" strokeWidth={2} />
      <span>{label}</span>
      <span className="text-text-void">·</span>
      <span className="text-text-void">{progress}</span>
    </div>
  );
}

function Composer() {
  return (
    <footer className="flex flex-col gap-[10px] border-t border-glass-border px-4 py-[14px]">
      <input
        type="text"
        disabled
        placeholder="Message goodboy-bot…"
        className="w-full cursor-not-allowed bg-transparent font-body text-[13px] text-text placeholder:text-text-void focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-text-void">
          <Paperclip className="h-[13px] w-[13px]" strokeWidth={1.5} />
          <AtSign className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </div>
        <div className="flex items-center gap-[6px] font-mono text-[11px] text-accent">
          <span className="font-medium">Send</span>
          <span>⏎</span>
        </div>
      </div>
    </footer>
  );
}
