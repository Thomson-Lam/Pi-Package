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
4. `/tree` is not always foolproof: after an initial implement -> review loop of a big plan, the next step of the plan might end up stepping over the initial, unless the user always prompts the agent explicitly that the original pass has been reviewed and that the agent should not change anything related to the previous step.

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

The proposed new workflow, with the above changes, would look like:

1. in a spec agent through muon and `/spec`, the use fleshes out product requirements and launches a build agent with `/build`
2. in a `/build` agent, the spec turns into an implementation plan 
3. if the context of this first build agent, B1, is larger than 40%, the user instructs the agent to launch a new agent:
  3.1. the agent launches an agent in the same manner as a tool call
  3.2. a TUI of the agent messages spawns (reuse `pi-telescope` or make a lightweight one if possible) and the user gets to select specific outputs B1 made to the user, such as the output of the implementation plan 
  3.3. a `/compact` is run (currently intending to use default compact if possible and test performance) to compact and preserve conversation progression and decisions leading to the implementation plan in under 100 words. This removes old temporal file reads, tool calls, and bash command outputs that no longer matter now that a plan is ready.
  3.4. this launches a new tmux pane with the agent + the following as input, with everything else the same as the current `olive-agents`.

So the flow is: agent tool or human runs `/mag` -> human TUI (context ledger building, whether the current agent should be allowed to continue while the launched agent is working, and whether to compact) -> then compacts and sends off subagent.

The agent gets launched with the following format:

```
# context 
<compacted context>
<user selected agent messages in markdown>
# instructions 
<agent prompt>
```

Notes:

- this attempts to keep the same working formula found by the user of human in the loop implementation without finnicky `/tree` jumping and provides the needed context for a good review, and does the same thing I did manually by navigating to a specific point in the tree, running `/ar`, and then navigating back to a point and instructing the main agent to launch the subagent, and then editing the prompt the main agent wrote to instruct the subagent to read the md file I saved at a specific file path. This gives the agent what it needs, minus the snapshot of file reads, write tool call results, and bash commands that a fresh session does not need, but keeps the important signals. This virtually achieves the same effect that I have been doing manually in a more streamlined manner, with more refined controls, and approval modals baked into it.
- this is not the same as a simple `/compact`, because we can parallelize, branch off asynchronously expanded beyond a single session tree with more than one agent, and have fine grained control over exact output preservation, which I think is enough as an evolution of subagents custom built for my workflow, and is a realistic and grounded optimization. While not used by the human, parallelization and longer workflows is now feasible with this structure, but this implementation should be kept at its most atomic and simplest base form possible because this should be a minimal and general purpose tool at the infra level for the harness, and not a Langgraph Pi. How I use this general tool is up to me to prompt, configure and decide in the future, we simply need to implement it such that it can be kept versatile and applied flexibly without needing to refactor or change how the code works. Every part of this re-uses concepts of Pi and links and extends parts of the Pi coding agent that already exists as a default feature baked in, so it should not be a complex, from the ground up implementation.
- the context ledger + flow above **only applies for launching a new fresh agent**, NOT for feedback back to the agent that launched it. That should be an output of the agent just like how `olive-agents` is right now with no change.
- since we are already rendering a TUI of the context ledger for inspection, we should use the same TUI for during the context ledger building (see below).
- this is a general purpose tool and does not enforce any semantics, conventions or how you should use the tools. This adheres to Pi coding agent's philosophy strictly, keeps the tool and infra versatile by not hard coding any semantics and abstractions which should be done at the skill level with the agents instead, which will be done and tweaked by the user and should not be within the co-agent application code itself directly. How to use, launch and instruct agents is a best practices that should be in context learning and loadable domain knowledge (skills).
- because this becomes a workflow and a chain designed for context optimization, adherance & alignment and HITL control, the context ledger is now the tree: this means that this context ledger needs to preserved and propagated or reusable/extensible with versioning, so co-agents, despite working in isolation and doing no A2A between >= 2 live always running agents, can function cohesively through each subsequent launch (see below)
- the existing `/mag` slash command that enables manual launching of agents needs to be reworked to use the same mechanism as this as well

Proposed context tree for conceptual clarity (not literal format):

```
B1 agent <name>
└── C1 (from /build agent 1 B1, used by /build agent B2)
    └── C2 (produced after B2 is done or launches a B3; is C1 appended by B2's context)
        └── C3 (produced after B3 is done or launches a B4; is C2 appeneded by B3's context)
```

If there is one additional agent launched at the C1 level, it would look like:

```
B1 agent <name>
└── C1_1 (from /build agent 1 B1, used by /build agent B2)
└── C1_2 (from /build agent 1 B1, used by /build agent B2)
    └── C2 (produced after B2 is done or launches a B3; is C1 appended by B2's context)
        └── C3 (produced after B3 is done or launches a B4; is C2 appeneded by B3's context)
```

Edge cases for the context ledger rendered: 

Case 1) If B2 is launched after B1 but B2 does not use any context ledger or compaction from B1, then the context tree would look like - 

```
B1 agent <name>
└── C1_1 (any additional agents launched with a context ledger or compaction built B1 will be treated the same)
B2 agent <name>
```

Because technically, there is nothing downstream in the context ledger from B1 -> B2. B2 is effectively a new, isolated agent and has the same effect as a normal subagent with isolated context and only receiving a prompt from the agent B1.

Case 2) If B3 is launched by B2, and B2 used a context ledger from B1, but B3 does not use any context ledger from B2 but B1, B3's ledger is treated at the same nested level as B2's since the have the same number of parents and thus should be at the same level-

```
B1 agent <name>
└── C1_1 (from /build agent 1 B1, used by /build agent B2)
└── C1_2 (from /build agent 1 B1, used by /build agent B3)
```

Case 3) If B3 is launched by B2 but B3 does not use any downstream context from B1 or B2-

```
B1 agent <name>
└── C1_1 (from /build agent 1 B1, used by /build agent B2)
B3 agent <name> C1_2 (treated the same as case 1)
```

To make the context ledger easier to use, I think rendering the agent session name in the ledger after the C numbering is needed. We need to flesh out how we name the context tree properly.

Requirements:

1. hooks that are configurable by the main agent and human, and hooks can be enabled, configured and disabled through a slash command in Pi chat `/ohooks`
2. prevent recursive guardrails
3. feedback to the human should be in each tmux pane for each agent rather than some custom centralized UI for the main agent; this sticks to the current philosophy of olive-agents.
  3.1. the feedback for the human should be in the form of a generic output and not some special TUI, the actions follow up for the human should be in TUI. Reference how the /cmd slash command workflow in this repo pulls up the custom TUI and follow that same TUI for this.
  3.2. this feedback should include agent context as well
4. the current bottom subagent display should evolve to include dismissal functionality through a keybinding or shortcut, and spawned agents should not disappear without the user focusing on them
5. we need a slash command `/ot` to render the context ledger properly; if the current agent session where /ot is invoked is the original agent like B1 in the example proposal above, then we simply render every context ledger built and agents invoked downstream and beneath it, but if the agent session invoked, is a child, then we need to a) show the same downstream agents invoked and the context ledgers, but also show that it is a child as well and be able to navigate outwards to show the ancestors to make the relation CLEAR and easy to trace using this TUI. Example with a proposed nomenclature/organization format:

Initial agent B1 with no agent that launched it - 

```
[A] <session name>
└── [C] <co-agent session name> 
    └── [C] <co-agent session name>

<vim keybindings footer for navigation>
```

Navigating to each `[C]` open a window with 2 options: render the context passed, or navigate to the agent's pane, or open the agent session in a new pane if it is not open as a tmux pane currently (see if this is possible). If the session where the /ot command was run is the first `[C]`:


```
[C] <co-agent session name>
└── [C] <co-agent session name> 

* h Show parent also included in the footer for nav, and highlighted in cyan.
```

Notes: 

- vim keybindings for navigation: h for parent, j and k for moving up and down and enter for opening the window with 2 options
- this is not the same as the sessions rendered shown by `/resume`. But we should still show a hierarchy based on the context, similar to how the current subagents sessions are organized in the sessions list by `/resume` right now:

Instead of -

```
<main-agent session name>
└── [S] - <co-agent session name> 
```

We do -

```
[0] - <agent session name>
└── [1] - <co-agent session name> # agent that spawned with context ledger from [0]
  └── [2] - <co-agent session name> # agent that spawned with a context ledger from [1] ([0] appended by agent [1])
```

And if there are parallels, we do - 

```
[0] - <agent session name>
└── [1a] - <co-agent session name> # agent that spawned with context ledger from [0]
└── [1b] - <co-agent session name> # agent that spawned with context ledger from [0], the same as 1a
  └── [2] - <co-agent session name> # agent that spawned with a context ledger from [1] ([0] appended by agent [1])
```

We should keep the existing semantics used for the agent name session from olive-agents, and make this context ledger follow the same format. For the agent sessions themselves, we should apply the same format as `/rn` and let the agent that launches it configure the naming.

6. the new additions must keep the tmux session performant; this means that we need to cap the max number of panes to 10 at most, which is more than enough. Once the limit is reached, notify and enforce the user to 
7. We put in hard agent turn stops and reconciliations/short syncs which use the same HITL UI for continuing, context ledger building and handoff, or feedback to the agent that spawned it, but never hard capping or stopping based on context window size.
8. To prevent infinite propagtion back to the initial starting agent, the human will take care of it since the human will review, but a heuristic of max 2 should be enforced because that means that the harness is seriously failing if it ever happens, and the human is not stopping it correctly. This will also be a soft guardrail in the skill designed for this.
9. reference how /logs requires the /tlogs skill enabled in muon, we want to use the same mechanism for the co-agents and skills for it and centralize/place this skill for using this new proposed olive-agents under muon.

Need figuring out:

1. Whether implementing subagent limits is required for this v0 iteration of subagent -> co-agents first: agent A spawns agent B out of necessity for context optimization and for task isolation, and every step goes through human in the loop approval: given the level of human control, I don't think a hard coded heuristic limiting the number of agents spawned to prevent recursiveness is required. This is to be determined later after testing.
2. worktree config and measures: this is likely a more required feature and I require help fleshing this out.
