import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@dashboard/lib/utils";

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-sm prose-invert max-w-none",
        "prose-headings:font-display prose-headings:text-text",
        "prose-p:text-text-dim prose-p:leading-relaxed",
        "prose-strong:text-text",
        "prose-a:text-accent prose-a:no-underline hover:prose-a:underline",
        "prose-code:font-mono prose-code:text-[11px] prose-code:text-text-secondary prose-code:bg-glass prose-code:border prose-code:border-glass-border prose-code:rounded prose-code:px-1.5 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-bg prose-pre:border prose-pre:border-glass-border prose-pre:rounded-md",
        "prose-li:text-text-dim prose-li:marker:text-text-ghost",
        "prose-blockquote:border-accent-dim prose-blockquote:text-text-ghost",
        "prose-hr:border-glass-border",
        "prose-th:text-text-secondary prose-td:text-text-dim",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
