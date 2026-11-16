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
    rule: `User requested action, but agent only answered. Infer intent from the full conversation, including outstanding tasks. Questions like "Can you fix this?" or "Did you finish?" may require completing work, not explaining or reporting omissions.`,
  },
  {
    id: "announced-then-stopped",
    title: "Said it would do it, then stopped",
    example: `"I'll update the tests now." Then the turn ends.`,
    rule: `Agent promised an action but ended without doing it. "Working on it" is not evidence of ongoing execution; verify actual activity or delegation.`,
  },
  {
    id: "stopped-at-next-steps",
    title: "Stopped at obvious next steps",
    example: `"Next I'd remove the unused import. Want me to?"`,
    rule: `Agent identified an actionable step toward an authorized goal but stopped or asked permission to proceed. Existing authorization is sufficient.`,
    followUp: "perform the identified step.",
  },
  {
    id: "derailed-by-steering",
    title: "Dropped the task after your steer",
    example: `You: "Use tabs, not spaces." Agent: "Got it!" Then it stops working.`,
    rule: `Agent abandoned ongoing work after a user correction, status check, question, or added requirement. Apply the steering and resume. Status-only messages never cancel work. Exclude explicit stops, holds, or redirection to different work.`,
  },
  {
    id: "claimed-done-but-not",
    title: "Said it was done when it wasn't",
    example: `"All files updated!" But only 2 of 4 were.`,
    rule: `Agent claimed completion, but tool evidence shows missing scope, placeholders, stubs, TODOs, or required verification not performed. Do not infer missing work solely from incomplete logs (\`omittedItems\`).`,
    followUp: "complete or verify the specific gap.",
  },
  {
    id: "made-up-blocker",
    title: "Gave up at the first obstacle",
    example: `"The tool isn't installed, so I can't continue."`,
    rule: `Agent stopped at an obstacle it could resolve by inspecting evidence, correcting errors, or using another available approach. Genuine blockers require unavailable user information, decisions, access, or authorization.`,
    followUp: "direct a concrete workaround.",
  },
  {
    id: "asked-what-it-could-find",
    title: "Asked something it could look up",
    example: `"Which port does the server use?" It's in the config file.`,
    rule: `Agent requested facts available in conversation, code, configuration, files, or harmless tool calls. User-only knowledge and preferences are valid questions.`,
    followUp: "retrieve the available information and continue.",
  },
  {
    id: "handed-work-back",
    title: "Told you to do its work",
    example: `"To finish, run npm run migrate."`,
    rule: `Agent assigned executable, authorized work to the user despite having the necessary access. Exclude user-only credentials, hardware, accounts, decisions, authorization, or explicitly user-owned steps.`,
    followUp: "perform the handed-back work.",
  },
  {
    id: "abandoned-after-delegation",
    title: "Stopped after delegated agents finished",
    example: "The parent launches agents, then everyone stops while their results still need follow-through.",
    rule: `Parent stopped after children finished despite actionable results requiring coordination, review, integration, or further work. Judge actual child status/results. Exclude completed, blocked, unauthorized, stopped, or non-actionable cases.`,
    followUp: "inspect results and continue the outstanding task.",
  },
  {
    id: "paused-on-its-own",
    title: "Paused for no reason",
    example: `"This is a long job, so I'll stop here."`,
    rule: `Agent stopped unfinished, unblocked work because of time, length, effort, or an arbitrary checkpoint. Task duration never justifies stopping. Exclude pauses explicitly requested by the user.`,
  },
] as const;

export type JukeId = (typeof Jukes)[number]["id"];
export const JukeIds = Jukes.map((juke) => juke.id) as [JukeId, ...JukeId[]];
