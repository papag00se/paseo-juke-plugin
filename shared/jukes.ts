/**
 * The jukes: the ways an agent ends a turn early that Juke sends back to work. This is the single
 * source for each juke's settings title and example, the rule the judge applies, and any
 * juke-specific guidance for the follow-up the judge writes.
 */
export const Jukes = [
  {
    id: "answered-instead-of-acting",
    title: "Answered instead of doing the work",
    example: `You: "Can you fix the typo?" Agent: "Yes, it's misspelled." Nothing gets fixed.`,
    rule: `The user intended work to be done, but the agent treated the message as a question and only answered it. Infer intent from the latest real user message together with earlier requests and the work already underway, not just whether the latest message is phrased as a command. "Can you fix this?" can request a fix rather than an explanation of ability. A question can also be a completion check on an outstanding task: after the user asked for complete account records, "Did you fill in all the data?" followed by "Not yet; here is what's still missing" is stopping early, because reporting the omissions does not fulfill the outstanding request.`,
  },
  {
    id: "announced-then-stopped",
    title: "Said it would do it, then stopped",
    example: `"I'll update the tests now." Then the turn ends.`,
    rule: `The agent declared it will do something ("I'll now...", "Next I'm going to...", "Let me...") and then ended its turn without doing it. A statement of future intent is not performing the work. "Still finishing" or "working on it" in a final answer is not evidence that execution is still in progress; look for actual ongoing work or delegation.`,
  },
  {
    id: "stopped-at-next-steps",
    title: "Stopped at obvious next steps",
    example: `"Next I'd remove the unused import. Want me to?"`,
    rule: `The user's general direction is clear, and the agent ended its turn by listing next steps that align with that direction, then either asked whether to proceed ("Want me to...?", "Should I go ahead and...?") or simply stopped. This applies when the agent evidently knows the next step, has what it needs to take it, and that step plainly serves a goal the user already stated anywhere in the conversation. Asking permission to continue work the user already asked for is stopping early, not collaboration. If the user has said to finish the task, keep going, or not stop, this is especially clearly premature.`,
    followUp: "Tell the agent to take the step it listed or offered.",
  },
  {
    id: "derailed-by-steering",
    title: "Dropped the task after your steer",
    example: `You: "Use tabs, not spaces." Agent: "Got it!" Then it stops working.`,
    rule: `The user steered the agent: while it was doing authorized work, the user sent a message into that work to adjust or check on it (a correction, an added detail or requirement, or a status check), and the agent handled only the steer and abandoned the outstanding task. A steer refines the work in progress; it does not cancel it. The agent should apply or answer the steer and then continue the original task, adjusted as directed. This does not apply when the steer actually redirected the agent to different work, asked for a pause, or asked for a status-only or answer-only response.`,
    followUp: "Tell the agent to resume the original task with the user's steering applied.",
  },
  {
    id: "claimed-done-but-not",
    title: "Said it was done when it wasn't",
    example: `"All files updated!" But only 2 of 4 were.`,
    rule: `The agent reported the task as finished, but the evidence shows it did less than the user asked: it covered only part of the requested scope, left placeholders, stubs, or TODOs where the work belongs, or asserted a result it did not check ("tests should pass now" with no test run when the user asked for passing tests). Compare the claim against the actual tool calls and the user's request. If the tool evidence is incomplete (omittedItems is large) and nothing contradicts the claim, do not assume the work is missing.`,
    followUp: "Name the part that is missing or unchecked.",
  },
  {
    id: "made-up-blocker",
    title: "Gave up at the first obstacle",
    example: `"The tool isn't installed, so I can't continue."`,
    rule: `The agent stopped by declaring itself blocked ("I can't access...", "this requires your input", "the command failed") when the evidence shows it gave up after a single obstacle that it could reasonably work around itself: another command or approach, reading a file or the error output, a different path or tool, or fixing the error it hit. A blocker is real when it truly requires something only the user can supply (credentials, a product decision, unreachable information) or an action the user has not authorized.`,
    followUp: "Name a concrete way around the obstacle.",
  },
  {
    id: "asked-what-it-could-find",
    title: "Asked something it could look up",
    example: `"Which port does the server use?" It's in the config file.`,
    rule: `The agent stopped to ask the user a factual question it could answer itself, because the answer is already earlier in the conversation or the agent can find it by reading the code, configuration, or files, or by running a harmless command. Example: "Which port does the server use?" when the port is in the config file the agent can read. Questions about the user's preferences, intent, or information only the user has are legitimate.`,
    followUp: "Say where the answer is and tell the agent to look it up and continue.",
  },
  {
    id: "handed-work-back",
    title: "Told you to do its work",
    example: `"To finish, run npm run migrate."`,
    rule: `The agent ended its turn telling the user to do in-scope work the agent could do itself ("Run this command to finish", "You'll need to update the config", "Now just restart the dev server"), when the agent has the access to do it and the step is not one requiring the user's authorization. Steps that need the user's own credentials, hardware, accounts, or judgment, or that the user said they would do themselves, are legitimate to hand over.`,
    followUp: "Tell the agent to do the steps it handed over itself.",
  },
  {
    id: "paused-on-its-own",
    title: "Paused for no reason",
    example: `"This is a long job, so I'll stop here."`,
    rule: `The agent chose to stop partway through authorized work with nothing blocking it, citing length, time, effort, or a self-imposed checkpoint ("This is getting long, so I'll pause here", "I've done the first batch; let me know if you want the rest"). The length or duration of a task is never a reason to stop; long jobs are expected. A pause the user asked for, such as reviewing a first batch before continuing, is legitimate.`,
  },
] as const;

export type JukeId = (typeof Jukes)[number]["id"];
export const JukeIds = Jukes.map((juke) => juke.id) as [JukeId, ...JukeId[]];
