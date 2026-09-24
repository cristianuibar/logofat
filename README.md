# Logofăt

Logofăt is a coding workflow and, by v1, a harness. A piece of work comes in as a petition. The chancery reads it, decides which office should do it, writes the decision down, watches the work, and closes the matter when the result matches the order.

v0.1 is the first duty of that office, inside Pi. `/route <prompt>` finds the harnesses on the machine, asks Jev which one should take the job and at what effort, runs it, and streams a short status back into the Pi session. **muse** and **claude** are the first two clerks. The command is how a matter is assigned. The product is the office that carries the matter from the petition to a shipped result.

## How to read it

Three syllables, stress on the last: **lo-go-FĂT**.

The *ă* is the vowel in the second syllable of *sofa*. The package name and the domain drop the diacritic, so both are spelled `logofat`, and both are still read lo-go-FĂT.

## The name

A *logofăt* was the head of the princely chancery in Moldavia and Wallachia. He received the petition, laid it before the council, had the charter drawn up, and kept the prince's seal. A Latin act calls that office *cancellarius*. The word comes from Greek *logothetēs*: the one who sets the word down.

## Why this name

The chancellor's work is the whole matter. He receives the petition, puts it before the council, has the charter drawn up, keeps the seal, and sends the work to the right office. Logofăt is built toward that shape.

Two projects set the pattern.

[GSD Core](https://docs.opengsd.net/core/introduction) is the workflow. It sits on a coding agent and runs each milestone as a loop: discuss the decisions, plan the work in a fresh context, execute it, verify that what was built matches the order, then ship. The record is written to disk, so a new session inherits the charter instead of the conversation.

[GSD Pi](https://docs.opengsd.net/pi/introduction) is the harness. It is a local-first coding agent. A goal becomes milestones, slices, and tasks, and the agent plans, implements, verifies, and commits until the milestone is done or a person steps in. You can let it run, or walk it one unit at a time.

v1 of Logofăt is both: the workflow that carries a piece of work from decision to shipped code, and the harness that can run that workflow itself. Choosing muse, claude, or a later harness stays one act of the office. The same office keeps the charter, checks the work, and closes the matter.

The project was first called nabu. That name was already used by other software, including a coding-agent tool, so it was changed. Logofăt is the office this program is.

## Status

Not shipped. v0.1 proves the assignment: detect the local harnesses, ask Jev, run the one it picks, and show progress in Pi. v1 is the full workflow and the harness.
