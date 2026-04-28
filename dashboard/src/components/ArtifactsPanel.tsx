/** Artifact chooser strip + markdown viewer. Owns its own fetch + toggle state. */

import { useState } from "react";
import { cn } from "@dashboard/lib/utils";
import { Markdown } from "./Markdown.js";
import { fetchArtifact } from "@dashboard/lib/api";

interface Artifact {
  key: string;
  label: string;
}

interface ArtifactsPanelProps {
  taskId: string;
  artifacts: readonly Artifact[];
}

export function ArtifactsPanel({ taskId, artifacts }: ArtifactsPanelProps) {
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  async function toggle(key: string) {
    if (active === key) {
      setActive(null);
      return;
    }
    setLoading(true);
    setActive(key);
    try {
      setContent(await fetchArtifact(taskId, key));
    } catch {
      setContent("Failed to load artifact");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="mt-3 flex gap-1.5">
        {artifacts.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => toggle(key)}
            className={cn(
              "rounded-full px-3 py-1 font-mono text-[10px] transition-all duration-200",
              active === key ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {active && (
        <div className="mt-3 rounded-lg bg-bg-raised p-4 animate-fade-up">
          {loading ? (
            <span className="font-mono text-xs text-text-ghost animate-pulse-soft">loading...</span>
          ) : (
            <div className="overflow-auto max-h-[600px]">
              <Markdown content={content} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
