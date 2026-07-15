---
name: authoring-skills
description: >
  Use when creating, revising, or evaluating reusable agent skills and their
  discovery descriptions.
---

# Authoring Skills

Write the smallest reusable guidance that corrects an observed, recurring
failure. Skills provide specialized knowledge or judgment; they should not
restate capabilities the model already applies reliably.

## Decide whether a skill is warranted

A skill is appropriate when guidance:

- applies across tasks or projects
- is not obvious from ordinary repository instructions
- requires a technique, reference, or recurring decision aid
- benefits from on-demand loading

Prefer an instruction file for project conventions, a system prompt for an
interaction mode, and code or permission hooks for mechanically enforceable
boundaries. Do not create a skill solely to route to other skills.

## Observe before prescribing

Use representative scenarios to see how agents behave without new guidance.
Record the consequential failure, not merely a different style preference. When
possible, repeat scenarios because one model response is noisy.

Write guidance that addresses the demonstrated gap. Test it against the same
scenario and nearby counterexamples. Compare with a no-guidance control when
wording effects are uncertain.

Discipline failures may need a clear boundary and escalation condition. Output
shape problems usually respond better to a positive description of useful
content than a long prohibition list. Conditional behavior should be tied to an
observable predicate.

## Keep discovery precise

The frontmatter description should state when to load the skill, using concrete
triggers and symptoms. It should not summarize the procedure so completely that
an agent can skip the body.

Use a valid lowercase, hyphenated name. Keep the main file concise and move
heavy reference material or reusable scripts into supporting files only when
needed.

## Avoid workflow capture

Do not make incidental matches mandatory. Do not create transitive invocation
chains unless each referenced skill independently applies. Avoid announcements,
fixed response formats, and universal procedures unless testing demonstrates
that the exact constraint is necessary.

A skill should improve judgment within its domain, not take ownership of the
entire engineering workflow.

## Validate revisions

Check discovery, application, non-application, and interaction with higher-level
mode instructions. Include counterexamples where the skill should remain
unused. Revise or remove guidance that adds ceremony without improving outcomes.
