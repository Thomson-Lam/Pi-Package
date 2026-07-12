# Handoff writing guidance

Create a markdown handoff artifact for the current Pi session.

You are the current visible Pi agent in this session. Use the conversation context already available to you. Do not dump the raw transcript. Synthesize a concise, useful handoff for another agent or future session.

## Content expectations

Write for another coding agent. Include what they need to continue effectively:

- concise project/task context
- important files or directories to read first
- decisions already made
- current status
- open questions, risks, or blockers
- next recommended actions
- validation or commands worth running, if known

Avoid irrelevant transcript details. Prefer pointers to files and durable context over chat chronology.

## File handling

Use normal file tools to create or update the target markdown file. Create parent directories if needed. If the target already exists, read it first and preserve/update still-relevant content rather than blindly replacing it.

## Completion response

After writing the file, reply briefly with:

- saved path
- selected template
- a short summary of what the handoff covers
