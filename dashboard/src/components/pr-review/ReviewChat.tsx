/** Right rail: goodboy-bot review chat. Minimal Lovable-style layout — no avatars per message,
 *  user messages as a navy bubble with timestamp below, bot messages as plain prose. */

import { ArrowUp, Paperclip, Plus } from "lucide-react";

interface ReviewChatProps {
  prNumber: number | null;
  branch: string | null;
}

export function ReviewChat({ prNumber: _prNumber, branch: _branch }: ReviewChatProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <ChatHeader />

      <div className="flex flex-1 flex-col gap-[22px] overflow-y-auto px-5 pb-4 pt-5">
        <BotMessage
          paragraphs={[
            { tone: "primary", text: "Took a pass at this stack — mostly clean, but I want to flag the rename in checkoutMachine." },
            { tone: "primary", text: "Anyone hydrating saved state from before this PR hits an unknown-state error and the cart silently drops. Worth widening the migration before we land it." },
          ]}
        />

        <UserMessage body="Right — do we still have anyone on the old stored shape, or is everyone past the v3 migration already?" />

        <StepRow label="reading telemetry · v2 sessions" />

        <BotMessage
          paragraphs={[
            { tone: "primary", text: "Telemetry says about 1.4% of sessions are still on the v2 shape — small, but enough that I'd rather widen the migration than ship and watch the support queue. Happy to write it if you want." },
          ]}
        />

        <UserMessage body="Yeah go for it. Add a quick test for the v2 shape too if it's cheap." />

        <BotMessage
          paragraphs={[
            { tone: "primary", text: "Done. Added a fixture covering the v2 string-shape and a regression assert on hydrate." },
            { tone: "dim", text: "Tests pass locally — pushing the patch in a sec." },
          ]}
        />

        <StepRow label="reviewing service/payments.ts · 3 of 6" />
      </div>

      <Composer />
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

function IconButton({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-text-ghost transition-colors hover:bg-glass hover:text-text-secondary"
    >
      {icon}
    </button>
  );
}

// --- Messages ---

interface BotParagraph {
  tone: "primary" | "dim";
  text: string;
}

function BotMessage({ paragraphs }: { paragraphs: BotParagraph[] }) {
  return (
    <div className="flex flex-col gap-2">
      {paragraphs.map((p, idx) => (
        <p
          key={idx}
          className={
            p.tone === "primary"
              ? "font-body text-[12px] leading-[1.65] text-text"
              : "font-body text-[12px] leading-[1.65] text-text-secondary"
          }
        >
          {p.text}
        </p>
      ))}
    </div>
  );
}

function UserMessage({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[280px] rounded-lg bg-info-dim px-3 py-2">
        <p className="font-body text-[12px] leading-[1.6] text-text">{body}</p>
      </div>
    </div>
  );
}

function StepRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-[10px] text-text-ghost">
      <span className="flex h-[20px] w-[20px] items-center justify-center rounded-md border border-glass-border bg-bg-raised">
        <span className="h-[5px] w-[5px] animate-pulse-soft rounded-full bg-accent" />
      </span>
      <span className="font-body text-[11px] text-text-secondary">{label}</span>
    </div>
  );
}

// --- Composer ---

function Composer() {
  return (
    <footer className="flex flex-col gap-[10px] border-t border-glass-border px-4 py-[12px]">
      <input
        type="text"
        disabled
        placeholder="Make, test, iterate…"
        className="w-full cursor-not-allowed bg-transparent font-body text-[12px] text-text placeholder:text-text-void focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-text-ghost">
          <IconButton label="Attach" icon={<Plus className="h-[14px] w-[14px]" strokeWidth={1.5} />} />
          <IconButton label="Mention" icon={<Paperclip className="h-[14px] w-[14px]" strokeWidth={1.5} />} />
        </div>
        <button
          type="button"
          aria-label="Send"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-bg transition-opacity hover:opacity-90"
        >
          <ArrowUp className="h-[14px] w-[14px]" strokeWidth={2.5} />
        </button>
      </div>
    </footer>
  );
}
