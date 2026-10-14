# Automata workbench

A TypeScript web workbench providing three types of formal machines (formal languages/automata):

- Deterministic Finite Automata (DFA) simulation
- Context-Free Grammar (CFG) derivation
- Pushdown Automata (PDA) simulation

> [!NOTE]
> The project was recently migrated from Python (Flask) to Typescript (Vite)
> Python is only used as a parity check during development (`backend/` is no longer maintained, and remains for archive only).
> New website: https://dfa-visualizer-nr2s.vercel.app/
> Old website: https://dfa-nr2s.vercel.app/

## Demo

Click the image below to watch the video <br>

<a href="http://www.youtube.com/watch?feature=player_embedded&v=Fqa5ndFz7Sk" target="_blank">
<img src="http://img.youtube.com/vi/Fqa5ndFz7Sk/maxresdefault.jpg" alt="Watch the video" width="1920" height="1080" />
</a>

## Setup

Requirements:

- Node.js 20+
- npm
- Python 3 (optional, required only for running Python parity tests)

Change to the application directory:

```bash
cd dfa-tscompiler
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build the application for production:

```bash
npm run build
```

## Useful commands

Run these commands inside `dfa-tscompiler/`:

```bash
npm run typecheck
npm run lint
npm run format
npm run test:automata
npm run test:parity
npm run test:e2e
npm run test:demo
npm run demo:validate
npm run demo:preview
npm run demo:record
npm run demo:render
npm run build
npm run preview
```

Command descriptions:

- `typecheck` — Runs `tsc --noEmit` to validate TypeScript types.
- `lint` — Runs ESLint across all source and test files.
- `format` — Runs Prettier across all `.ts` and `.tsx` files.
- `test:automata` — Executes the TypeScript engine simulation test suite.
- `test:parity` — Verifies TypeScript engines against the Python reference in `backend/`.
- `test:e2e` — Runs automated Playwright browser tests for viewports, non-collision, and trace stepping.
- `test:demo` — Checks showcase samples, safe camera bounds, scene cues, pacing, and loop continuity.
- `demo:validate` — Validates the Webreel interaction config without recording.
- `demo:preview` — Previews the interaction script in a visible browser (requires the dev server; camera moves are added during export).
- `demo:record` — Records and exports the cinematic MP4, looping GIF, and poster.
- `demo:render` — Re-exports camera moves and captions from the latest validated capture.
- `build` — Checks types and compiles the production bundle with Vite.
- `preview` — Serves the production build locally with Vite.

## Project structure

All paths below are relative to `dfa-tscompiler/`:

```text
src/
  main.tsx                          Vite entry point
  App.tsx                           Workbench layout, simulation state, and trace controls
  index.css                         Tailwind imports, theme tokens, and SVG graph styles
  components/
    automata/
      GraphCanvas.tsx               SVG renderer for DFA and PDA graphs
    ui/
      button.tsx                    shadcn button primitive
      select.tsx                    shadcn select primitive
      tabs.tsx                      shadcn tabs primitive
  lib/
    utils.ts                        Utility functions
    automata/
      types.ts                      Shared types for DFA, CFG, PDA, and graph models
      dfa.ts                        DFA validation and simulation
      cfg.ts                        DFA-to-CFG derivation and CFG simulation
      pda.ts                        DFA-to-PDA derivation and PDA simulation
      layout.ts                     Graph model coordinate generation
      examples.ts                   Preset machines and sample strings
scripts/
  automata-tests.ts                 TypeScript engine test suite
  parity.ts                         Python oracle parity test runner
  e2e-tests.ts                      Playwright browser end-to-end test suite
```

## How the workbench works

`src/main.tsx` initializes the application and renders `<App />`.

`src/App.tsx` coordinates workbench features:

- Switches between preset machines and simulation modes (`DFA`, `CFG`, `PDA`).
- Runs the active mode simulator for input strings.
- Drives step-by-step playback with active trace auto-scrolling.
- Computes graph models for DFA and PDA visualizers.
- Manages control, trace, and visualizer panels.

All machine data is processed locally in TypeScript without external network requests.

## Machine definitions and customization

Edit preset machines in `src/lib/automata/examples.ts`.

Each preset starts from a `DFADefinition`. The application derives equivalent CFG and PDA models from that DFA.

### DFA definition fields

`DFADefinition` in `src/lib/automata/types.ts` defines these fields:

- `id`: Unique identifier across the app
- `name`: Machine name displayed in the UI
- `expression`: Regular expression string displayed in the control panel
- `description`: Summary of accepted patterns
- `alphabet`: Array of allowed input symbols
- `states`: Array of state objects with `id` and optional `label`
- `startState`: Initial state ID
- `acceptingStates`: Array of accepting state IDs
- `trapStates`: (Optional) Trap state IDs for dead-end transitions
- `transitions`: Transition mapping per state and symbol
- `layout`: (Optional) Manual `{ x, y }` node coordinates for SVG rendering
- `stopOnTrap`: (Optional) Stops simulation immediately upon reaching a trap state
- `samples`: Accepted and rejected test strings

### Adding a new machine

Define your machine in `src/lib/automata/examples.ts`:

```ts
const myDfa: DFADefinition = {
    id: "ends-with-01",
    name: "ENDS_01",
    expression: "(0 + 1)*01",
    description: "Accepts binary strings ending in 01.",
    alphabet: ["0", "1"],
    states: [
        { id: 0, label: "q0" },
        { id: 1, label: "q1" },
        { id: 2, label: "q2" },
    ],
    startState: 0,
    acceptingStates: [2],
    trapStates: [],
    transitions: {
        0: { "0": 1, "1": 0 },
        1: { "0": 1, "1": 2 },
        2: { "0": 1, "1": 0 },
    },
    layout: {
        0: { x: 80, y: 120 },
        1: { x: 220, y: 120 },
        2: { x: 360, y: 120 },
    },
    samples: {
        accepted: ["01", "101"],
        rejected: ["", "0", "11"],
    },
};
```

Add your machine to the preset export:

```ts
export const AUTOMATA_PRESETS: AutomataPreset[] = [
    createPreset(betsDfa),
    createPreset(starsDfa),
    createPreset(myDfa),
];
```

## Graph layout and rendering

The graph renderer uses two distinct layers:

1. `src/lib/automata/layout.ts` computes a `GraphModel` containing nodes, grouped edges, and a bounding `viewBox`.
2. `src/components/automata/GraphCanvas.tsx` renders the model into pure SVG.

Layout highlights:

- Transitions sharing source and destination nodes merge into single labeled edges.
- Edge geometries curve symmetrically when bidirectional transitions exist.
- Self-loops render as circular arcs, directing trap loops downward.
- If manual coordinates are omitted, layout defaults to a radial arrangement.

## Testing architecture

The test suite enforces stability across three distinct layers:

1. **Engine unit tests (`npm run test:automata`)**:
   Validates acceptance, rejection, and state sequence generation against documented samples and generated strings.
2. **Oracle parity tests (`npm run test:parity`)**:
   Asserts strict equivalence between the TypeScript engine and the Python backend reference.
3. **End-to-end browser tests (`npm run test:e2e`)**:
   Verifies responsive viewport layout, absence of horizontal overflow, bounding-box non-collision, and trace auto-scrolling using Playwright.
