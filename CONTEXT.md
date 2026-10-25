# Corgi agent identity

Corgi displays provider conversations in terminal panes or runs them without a terminal.

## Language

**Session ID**: The provider's conversation ID. Pair it with the provider name when addressing a session; starting a headless agent returns this ID once the provider creates it.
_Avoid_: Native ID, headless ID, Corgi session ID

**Pane ID**: Corgi's numeric ID for a terminal pane. Pane commands use it to address the terminal, which may display different sessions over time.

**Headless agent**: An agent Corgi runs through a provider client without a terminal. Its process and Corgi's internal bookkeeping handles are implementation details, not additional session identities.

**Task goal**: An outcome an agent is working toward. It may come from the agent's own plan or be inferred by Corgi from observed work, and can span several user follow-ups.

**Activity**: An observed interval of work toward a task goal, such as investigating, implementing or verifying. Work without a supported goal association remains unassigned.

**Supplied plan**: Tasks and their states explicitly reported by an agent. Corgi may associate activities with its tasks, but does not infer changes to their names, completion states or blockers.
