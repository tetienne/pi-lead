const MAX_IDEA_CHARS = 4_000;

export function planningSkillPrompt(idea: string): string {
  const normalized = idea.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > MAX_IDEA_CHARS) {
    throw new Error("Planning idea must contain between 1 and 4000 characters");
  }
  return `/ask-matt I want to plan this multi-session engineering idea: ${normalized}. Use the actual Matt workflow. Start with /grill-with-docs; delegate /research only for facts needing primary sources and keep that network access explicit. Do not implement anything. After settled decisions, use /to-spec, obtain human approval of its test seams, use /to-tickets, show the proposed vertical tickets and blocking edges for human granularity approval, then publish the approved local tracker files.`;
}
