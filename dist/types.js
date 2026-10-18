// Shared types between the T3 state reader, the presence model and the daemon.
//
// PRIVACY RULE: nothing in here may ever carry a thread/chat title, message
// text, prompts, tool input/output, file paths or diffs. The reader never
// selects those columns. Only statuses, provider/model identifiers, counts,
// timestamps and token numbers cross this boundary. The one exception is the
// project folder name, which is only read when the user opts in.
export {};
