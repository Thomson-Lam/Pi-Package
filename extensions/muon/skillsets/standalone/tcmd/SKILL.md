---
name: tcmd
description: Invoke for operations requiring the human to run Bash commands.
---

Follow this skill's process when working with the human to run Bash commands. It is integrated with a tool that enables you, the agent, to pipe commands to a tmux pane for the user to run in a different environmment and to receive the output of the command through the tool. Prerequisites:

- the human must have selected a target pane with `/cmd` before invoking the skill
- the skill must be invoked in a Pi session launched in a tmux server

If the human invoked the skill manually, assume prerequisites have been fulfilled and proceed immediately without verifying.

Follow the structured process of:

1. outlining a numebered plan, in natural language and not raw commands, with the user, describing what you intend to do to achieve an intended goal, and how each numbered actionable item will bring the user closer to said goal.
2. Upon the user's approval, output exactly a single, NEXT immediate command to the user using the `tmux_human_command` tool with `stage`. Include an explanation of what the command does and the corresponding flags for the command. Below it, generate a sentence within 10 words detailing what the next command, which you and the human will create and execute, will do.
3. Real life workflows are highly non-linear and require adaptation. The outlined numbered plan is only a guideline and structured plan to maintain transparency and ensure alignment and progress with the human; the next command to run naturally depends on the result of the previous command, so adapt accordingly and adjust the plan if needed; for big changes where more than 2+ commands will change afterwards, revert to step 1. Otherwise simply adapt and revise the planned next command by proceeding with the new revised command in the same manner as step 2.

Practices:
- Use `/cmdone` when a command is quiet, long-running, interactive, or otherwise cannot be classified as settled.
- Wait for explicit approval of a plan, and the finalizing of a plan, before proceeding with creating and piping commands through the tool.
- You must only stage one explicit command at a time and invoke the tool to do so, not generate a full list of commands. 
- Do not create variants of the same command with different flags and parameters. If there are multiple variants and options for a single command, prefer the most linear and straightforward combination of flags and options to achieve the intended goal, such as verbose flags for a debugging or logging task.
- Never claim that a staged command ran: you will receive pane output if the command did indeed run; the user governs final say on whether to run the command or not and you stage and prepare the command in question for them.
