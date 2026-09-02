export const NEVER_REUSE_TASK_PROMPT_LINES = [
	"Never reuse, copy, adapt, or continue any previous task's answer, Message, tool result, or final response as the answer for this task.",
	"Treat inherited session history and prior task context as background only; the current prompt's stage, identifiers, schema, paths, and input JSON are authoritative.",
	"Before submitting output, verify it was produced for the current task identifiers in this prompt. If older context conflicts with this prompt, ignore the older context.",
];
