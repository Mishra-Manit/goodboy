/** Shared palette + icon map for the log-viewer subtree. */

import { Terminal, FileText, Pencil } from "lucide-react";
import type { LogEntryKind } from "@dashboard/lib/api";

export const KIND_COLOR: Record<LogEntryKind, string> = {
  text: "text-text-secondary",
  tool_start: "text-text-secondary",
  tool_update: "text-text-ghost",
  tool_end: "text-text-secondary",
  tool_output: "text-text-ghost",
  stage_info: "text-accent",
  rpc: "text-text-void",
  error: "text-fail",
  stderr: "text-warn",
};

export const TOOL_ICON: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  edit: Pencil,
  write: Pencil,
};
