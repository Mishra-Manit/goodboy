/** Right rail: goodboy-bot review chat. Visual layout from Pencil V8 stacked diff. */

import { AtSign, Loader2, Paperclip } from "lucide-react";

interface ReviewChatProps {
  prNumber: number | null;
  branch: string | null;
}

export function ReviewChat({ prNumber, branch }: ReviewChatProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <ChatHeader prNumber={prNumber} branch={branch} />

      <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[18px] pb-2 pt-[18px]">
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
    <header className="flex items-center gap-2 border-b border-glass-border px-[18px] py-[12px]">
      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-ok" />
      <span className="shrink-0 font-display text-[13px] font-medium text-text">goodboy-bot</span>
      <span className="ml-auto flex min-w-0 items-center gap-2 font-mono text-[10px] text-text-void">
        {prNumber !== null && <span className="shrink-0">#{prNumber}</span>}
        {branch && <span className="truncate">{branch}</span>}
      </span>
    </header>
  );
}

interface BotParagraph {
  tone: "primary" | "dim";
  text: string;
}

function BotMessage({ time, paragraphs }: { time: string; paragraphs: BotParagraph[] }) {
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">gb</span>
        <span className="font-mono text-[10px] text-text-void">{time}</span>
      </div>
      <div className="flex flex-col gap-[6px] border-l border-glass-border pl-[14px]">
        {paragraphs.map((p, idx) => (
          <p
            key={idx}
            className={
              p.tone === "primary"
                ? "font-body text-[12px] leading-[1.55] text-text"
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
        <span className="font-mono text-[10px] text-text-void">{name}</span>
        <span className="font-mono text-[10px] text-text-void">{time}</span>
      </div>
      <div className="max-w-[300px] rounded-lg bg-accent-ghost px-3 py-[6px]">
        <p className="font-body text-[12px] leading-[1.55] text-text">{body}</p>
      </div>
    </div>
  );
}

function TypingIndicator({ label, progress }: { label: string; progress: string }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] text-text-dim">
      <Loader2 className="h-[10px] w-[10px] animate-spin text-accent" strokeWidth={2} />
      <span>{label}</span>
      <span className="text-text-void">·</span>
      <span className="text-text-void">{progress}</span>
    </div>
  );
}

function Composer() {
  return (
    <footer className="flex flex-col gap-[10px] border-t border-glass-border px-4 py-[12px]">
      <input
        type="text"
        disabled
        placeholder="Message goodboy-bot…"
        className="w-full cursor-not-allowed bg-transparent font-body text-[12px] text-text placeholder:text-text-void focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-text-void">
          <Paperclip className="h-[13px] w-[13px]" strokeWidth={1.5} />
          <AtSign className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </div>
        <span className="font-mono text-[10px] text-accent">Send ⏎</span>
      </div>
    </footer>
  );
}
