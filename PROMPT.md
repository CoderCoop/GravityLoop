# Reconstitution prompt — rebuild GravityLoop from scratch

GravityLoop was specified in conversation and written by an AI coding agent.
The specification that reconstitutes it ships with it, in the standard
[spec-driven development](https://github.com/github/spec-kit) triad that
GitHub Spec Kit and Amazon Kiro both use, so an agent already knows the
layout:

| File | Contents |
| --- | --- |
| [`spec/requirements.md`](spec/requirements.md) | **What to build.** Normative requirements in [EARS](https://alistairmavin.com/ears/) notation with [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) keywords and stable IDs. |
| [`spec/design.md`](spec/design.md) | **How it hangs together.** Module boundaries, data model, and the rationale behind decisions that were reached the hard way. |
| [`spec/tasks.md`](spec/tasks.md) | **What order to build it in.** Phased tasks, each naming the requirements it satisfies and the check that proves it. |
| [`AGENTS.md`](AGENTS.md) | Standing conventions for agents working on the repo (`CLAUDE.md` symlinks to it). |

## The kickoff prompt

Paste this into a capable coding agent in an empty directory, with the four
files above available to it:

> Build **GravityLoop**, a browser game: spaceship golf across gravity wells
> rendered as 3D neon wireframe terrain. Gravity is drawn as terrain — every
> mass bends a wireframe grid into a well, and the ship's height on that
> surface *is* its potential energy. The player drags back from the ship and
> releases, golf style; a live prediction line shows exactly where the shot
> goes, and fewer launches earn more stars.
>
> `spec/requirements.md` is normative — implement every `REQ-` in it, and
> treat the numeric values as given rather than deriving your own, since they
> are the result of tuning. Follow the architecture in `spec/design.md`,
> especially the shared physics core: the browser game and the offline solver
> **must** import the same module, so they can never disagree about the
> outcome of a launch. Work the phases of `spec/tasks.md` in order and do not
> start a phase until the previous phase's checks pass.
>
> Three gates decide whether you are done, and all three must pass in CI:
> the solver confirming every leg of all 50 levels is winnable, a headless
> layout test confirming no HUD element escapes the viewport at phone,
> tablet and desktop sizes, and a headless smoke run that loads the game and
> launches with zero console errors.
>
> Two rules matter more than they look. First, **measure, never argue**:
> difficulty, winnability and orbit speed are outputs of running the real
> physics, not conclusions you reason your way to. Second, **for anything
> the player sees, render options and get them chosen before implementing**
> — prose descriptions of visual choices are unreliable, renders are not.

## Why it is shaped this way

The requirements are separated from the design because the requirements
outlived several implementations of the same behaviour during development —
the aim-precision model was rebuilt twice and the orbit-assignment rule three
times, while what the player needed never changed.

The rationale notes in `design.md` exist because the expensive mistakes in
this project were all the same shape: assuming a property instead of
verifying it. The most costly example is recorded there in full — slowing an
orbit does not move its path, so a time-sampled clearance check reports a
false pass while the collision merely moves outside the sampling window.
