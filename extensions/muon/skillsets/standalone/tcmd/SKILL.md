---
name: tcmd
description: Invoke for operations requiring the human to run Bash commands.
---

Follow this skill's process when working with the human to run Bash commands. It is integrated with a tool that enables you, the agent, to send commands to a tmux pane and receive bounded output from that pane. Prerequisites:

- the human must have selected a target pane with `/cmd` before invoking the skill
- the skill must be invoked in a Pi session launched in a tmux server

If the human invoked the skill manually, assume prerequisites have been fulfilled and proceed immediately without verifying.

Follow the structured process of:

1. outlining a numbered plan, in natural language and not raw commands, with the user, describing what you intend to do to achieve an intended goal, and how each numbered actionable item will bring the user closer to said goal.
2. Upon the user's approval, output exactly a single, NEXT immediate command to the user using the `tmux_human_command` tool with `stage`. Pass one observation strategy: `observe` which records the output of a pane for a short command or `record` for a long, interactive, or uncertain command that takes longer than 30 seconds to run. Include an explanation of what the command does and the corresponding flags for the command. Below it, generate a sentence within 10 words detailing what the next command, which you and the human will create and execute, will do.
3. Real life workflows are highly non-linear and require adaptation. Your outlined numbered plan should only be a guideline and structured plan to maintain transparency and progress with the human; the next command to run naturally depends on the result of the previous command, so adapt accordingly and adjust the plan if needed; for big changes where more than 2+ commands will change afterwards, revert to step 1. Otherwise simply adapt and revise the planned next command by proceeding with the new revised command in the same manner as step 2.

Practices:

- Choose `observation: "observe"` for commands expected to finish and settle within the observer limit. Choose `observation: "record"` for long-running, interactive, user-driven, or uncertain commands. Prefer `record` when completion time is uncertain, or if the previous attempt with `observe` did not yield expected, conclusive results.
- In `Staging`, the tool types the command into the selected pane but does not press Enter. Do not claim that it ran. For `observe`, tell the human to review the command and press Enter in the target pane. For `record`, tell the human to press Enter and say `done` when the command finishes.
- In `Full-staging`, the tool types the command and presses Enter automatically after the human approves the command review. Do not tell the human to go to the pane or press Enter. For `record`, tell the human to say `done` when the command finishes.
- When the human says `done` for a recorded command, call `tmux_human_command` with `action: "record-stop"`. Do not invent a separate manual completion command.
- An `observe` result with `confidence: "observation-timeout"` means the command may still be running. Do not claim completion. If no output was captured, report that the command took longer than the observer limit to run, and request the user to clean up such that you may run the command again with `record` instead.
- Every command review offers `Approve`, `Give feedback`, and `Cancel`. If the human gives feedback, do not execute the command. Treat the returned feedback as instructions to revise the command, then present the revised plan and next command.
- Wait for explicit approval of a plan, and the finalizing of a plan, before proceeding with creating and piping commands through the tool.
- You must only stage one explicit command at a time and invoke the tool to do so, not generate a full list of commands.
- Do not create variants of the same command with different flags and parameters. If there are multiple variants and options for a single command, prefer the most linear and straightforward combination of flags and options to achieve the intended goal, such as verbose flags for a debugging or logging task.
- Never claim that a staged command ran unless the tool reports that it was submitted and executed. You will receive pane output if the command did indeed run; the human governs final say on whether a staged command should be run.
