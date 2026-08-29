Current workflow:

The user has personally found that large scale subagent delegation without breaking things down, providing a focused scope and task to tackle, then fleshing specifics out with an agent synchronously with human understanding and being in the loop leads to subpar results. They follow Pi's philosophy to create a direct and minimal use of agents and subagents, such that the workflow is human driven rather than agent driven. The human is thus very involved in the implementation loop and actively reviews implementation plans and makes decisions rather than directly jumping into the code.

Thus, the user takes advantage of subagents not for high productivity and task parallelization, but for context and cost optimizations and isolating tasks such as research, implementation and review such that the main agent session the user is in usually is involved in direct implementation instead.

The user uses a mix of `/tree` and subagents along with a strict separation between spec -> requirements, then requirements -> implementation plan and finally the implementation itself:

1. in a spec agent through muon and `/spec`, the use fleshes out product requirements and launches a build agent with `/build`
2. in a `/build` agent, the spec turns into an implementation plan 
3. there is no subagent orchestration, the native session that came up with the plan directly implements it
  3.1. if the implementation plan is big and contains multiple layers of implementation for a single feature, `/tree` is used: a slice of the plan is implemented, then the user either uses a subagent for review, or directly navigates back to the point where the main agent brainstormed a plan and asks for a review
  3.2. if the implementation plan is small enough to fit within the current session, then continue 

The user plans -> implements -> reviews and repeats this for big plans and features. But this does not work very well despite the manual `/tree` slicing and optimization because:

1. OpenAI models of 272k context window is being used right now for the planning, and the implementation builds up even with subagents; the user currently mitigates this by switching the implementation session model to bigger 1M context models but the performance has proven to be subpar, requiring multiple review passes to go back and fix the gaps in the work, compared to just using the OpenAI model directly in one pass.
2. the process is bottlenecked and requires a lot of synchronous and manual human finesse to do so.
3. using subagents does not help because the subagent only gets the prompt from the main agent, and anything that the subagent returns goes directly back to the main agent to implement, or the main agent delegates, which introduces more drift and takes longer to implement something that is already straightforward due to the context limit.

And the current olive-agents, while providing review, is unable to solve these problems because of the following pain points:

1. passing context through the suabgents is bad: the only source of context that the subagent gets is a prompt from the main agent, but sometimes based on my current workflow, the important context may be an implementation plan and some of the things that happened between the user and the main agent. Garbage in , garbage out, so naturally a better context for the subagent is required. I currently bypass this by using `/ar` and saving the responses of the main agent as a md file for the subagent to get a sense of the implementation plan. The main agent itself always writes a prompt for the subagent but the prompt always introduces drift because based on my current workflow, the subagent is unaware of the prior context, rationales and decisions that led up to the action it is performing, leading to subpar reviews that are completely off the mark with wrong assumptions and implementation drifts. This is fine with basic codebase investigations but not ideal for other use cases that require information and alignment. In short, subagents do a bunch of nothing and end up burning more time and resources because they are not directed enough yet.
2. when a subagent finishes, it directly pipes the results back into the main agent loop with no context considerations, which is what the user is optimizing for 
3. flawed reconciliation mechanics: the main agent can choose to delegate a subagent with a limited amount of turns or unlimited, and for limited, the subagent is forced to terminate immediately without the human being in control of that. We need a reconciliation and a sync mechanism for the human to decide if it is worth continuing the subagent's work.
4. bad event transmission transparency: in the main agent's chat, when a subagent sends its results back through the outbox, the result is visible. But the converse is not the same, the subagent's chat does not show the same visible UI, which is very opaque
5. the main agent can continue executing while the subagent is working: this behavior should be configurable: stop and await for a result that is returned or not
6. subagents are not fully utilizable: the `resume` by the main agent is brittle, and for a user, it is hard to be able to control when the subagent should just directly execute the action rather than return to main agent to go through the human or implement themselves. This is a choice that the user makes based on the context consumption, and thus should be for them to decide.

Most of these points above stem from a lack of control for how the subagents are used, and most of them are forced to tie back into the main agent, which does not help with the current workflow and the context vs performance ROI problem itself that the user wants fine grained control over. Thus, 

The next natural evolution is from subagents to co-agents, through the following:

- "unroll the tree" (addresses 1): turn the `/tree` manual navigations into a context ledger that can be built for a more compact transition and context across multiple of these tree branches, such that this "tree" is no longer within a single Pi session but rather a compact context enabling branching out across. The context ledger is the new tree.
- secondary optimization: because most agents run ie. a test suite present in the repo most of the time anyways, and since the current new direction is to have extremely transparent HITL, why not create a new configurable hooks system such that this is run before providing a decision to the human to further decide? A hook can be a simple bash command that is executed using the Bash tool under the hood.
- improved tmux pane mechanics: an agent session stays until the user actively dismisses it using the agent viewer/list below the chat bar 
- verbose emitters (addresses 4): when an agent pipes back to the agent that spawned it, this is rendered as an actual event/UI in the agent's chat like get_subagent_result.
- configurable launch agent config: the user is able to control whether the main agent can continue working (the agent loop continues, and Pi shows the agent as "working...") in the launch approval UI
- human executive decisions for each agent launched (addresses 2 and 6): the human can see and review the results of the agent that completed and decide from there what they should do going forward 
- better reconciliation (addresses 2 and 3): force the agent to decide a fixed number of turns for each co agent it launches, and every time the turn is reached, require a report to the user about findings and next steps, and the user can navigate to that exact tmux pane with the agent running through the list below the chat bar, and use the TUI selectList opened in that agent session to decide whether to emit a result back to the agent that spawned it or have the agent continue prompting it to keep going, or to spawn a new fresh agent using the same context ledger mechanics to continue the work

Requirements:

1. hooks that are configurable by the main agent and human, and hooks can be enabled, configured and disabled through a slash command in Pi chat `/ohooks`
2. prevent recursive guardrails
3. feedback to the human should be in each tmux pane for each agent rather than some custom centralized UI for the main agent; this sticks to the current philosophy of olive-agents.
  3.1. the feedback for the human should be in the form of a generic output and not some special TUI, the actions follow up for the human should be in TUI. Reference how the /cmd slash command workflow in this repo pulls up the custom TUI and follow that same TUI for this.
4. the current bottom subagent display should evolve to include dismissal functionality through a keybinding or shortcut, and spawned agents should not disappear without the user focusing on them

Need figuring out:

1. Whether implementing subagent limits is required for this v0 iteration of subagent -> co-agents first: agent A spawns agent B out of necessity for context optimization and for task isolation, and every step goes through human in the loop approval: given the level of human control, I don't think a hard coded heuristic limiting the number of agents spawned to prevent recursiveness is required. This is to be determined later after testing.
2. worktree config and measures: this is likely a more required feature and I require help fleshing this out.
