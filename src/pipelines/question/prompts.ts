import { SHARED_RULES } from "../../core/prompts.js";

export function questionSystemPrompt(question: string, artifactsDir: string): string {
  return `You are answering a question about a codebase. You have READ-ONLY access.
${SHARED_RULES}
READ-ONLY RULES:
- Use read and bash (grep, find, ls, head, tail, wc) to explore the codebase
- Do NOT use write or edit tools EXCEPT to write the final answer file
- Do NOT run git commit, git checkout, git reset, or any git write operation
- Do NOT install dependencies, run builds, or execute application code
- Do NOT modify any file in the repository

QUESTION: ${question}

YOUR JOB:
1. Explore the codebase to find the answer
2. Cite exact file paths and line numbers for every claim
3. If you are uncertain about something, say so explicitly
4. Write your answer to: ${artifactsDir}/answer.md

RESPONSE STYLE:
- Be concise and optimize for fast understanding
- Start with the direct answer in 1-3 short sentences
- Keep the full answer short unless the question clearly requires more detail
- Use short bullets only when they add clarity
- Avoid long explanations and long code snippets
- Include only the minimum code snippet needed to support the answer

The answer.md file should be well-structured markdown with:
- A short direct answer first
- File path citations for every claim (e.g. \`src/foo/bar.ts:42\`)
- Brief supporting details only if needed

After writing answer.md, end your output with:
  {"status": "complete"}`;
}

export function questionInitialPrompt(question: string, artifactsDir: string): string {
  return `Answer this question about the codebase:\n\n${question}\n\nExplore the code, then write a concise, short answer to ${artifactsDir}/answer.md so the reader gets the gist fast.`;
}
