# Technical documentation

This document details the automata simulation algorithms, grammar derivation pipelines, rendering systems, and testing hierarchy.

## Algorithm and grammar processing

The core engine implements deterministic evaluation and mechanical model transformations without external dependencies.

### State-transition evaluation

The DFA engine evaluates inputs deterministically:

- Transitions are stored in a nested hash table keyed by source state and symbol.
- The simulator performs a single left-to-right scan of the input string without backtracking.
- Each character transition takes $O(1)$ amortized time.
- The engine validates symbols against the alphabet before each transition.
- Trap states halt evaluation early and trigger rejection.
- Invalid symbols, missing tables, and undefined targets produce distinct error codes.

### Time and space complexity

- **Simulation time**: $O(n)$ where $n$ is input string length.
- **Auxiliary space**: $O(n)$ to retain step records and state sequences for timeline animation.
- **Transition storage**: $O(|Q| \cdot |\Sigma|)$ worst-case for total DFAs.
- **Validation**: $O(|Q| \cdot |\Sigma|)$ single-pass check for transition totality, symbol integrity, and state reachability.

### Grammar and machine derivation

The engine mechanically derives equivalent formal models from the source DFA definition:

- **Right-linear CFG derivation**:
    - Each DFA state maps to a non-terminal symbol.
    - Each transition $\delta(A, a) = B$ maps to production $A \to aB$.
    - Each accepting state includes the empty production $A \to \varepsilon$.
    - The derivation engine uses breadth-first search with visited-state pruning to determine the leftmost derivation.
- **Pushdown Automata (PDA) derivation**:
    - Each transition reads an input symbol, inspects the stack top, and pushes state markers over bottom-of-stack $Z_0$.
    - The simulator explores configuration tuples of `(state, input_position, stack)` using breadth-first search.
    - Signature-based visited sets and queue depth caps guarantee termination on $\varepsilon$-transitions.

## Visualization and testing architecture

### SVG graph rendering

The visualizer renders interactive diagrams using pure React and SVG:

- **Radial layout engine**: Calculates polar coordinates around a dynamic radius when manual coordinates are absent.
- **Edge routing**: Trims straight lines to circular node perimeters and applies quadratic Bézier curves for bidirectional paths.
- **Self-loops**: Computes circular arcs with dedicated orientations (upward for normal loops, downward for trap states).
- **State nodes**: Renders double rings for accepting states, entry arrows for start states, and dashed outlines for trap states.
- **Timeline synchronization**: Propagates playback index changes to node fills, edge stroke weights, and trace list items simultaneously.

### Test suite hierarchy

The test suite validates stability through three separated layers:

1. **Unit tests (`scripts/automata-tests.ts`)**:
    - Executes table-driven test cases covering accepted patterns, rejected strings, and error states.
    - Generates exhaustive strings up to fixed lengths to verify DFA, CFG, and PDA engine equivalence.
2. **Oracle parity tests (`scripts/parity.ts`)**:
    - Invokes the Python reference engine in `backend/`.
    - Validates that state sequences, final states, CFG derivations, and PDA stacks match the reference output exactly.
3. **End-to-end browser tests (`scripts/e2e-tests.ts`)**:
    - Spawns headless Chromium via Playwright against the local preview build.
    - Verifies responsive layout across Mobile (375px), Tablet (768px), and Desktop (1024px, 1280px) viewports.
    - Asserts zero horizontal overflow (`scrollWidth <= clientWidth`).
    - Asserts non-collision between heading and description bounding boxes.
    - Verifies trace playback auto-scrolling keeps the active step within the visible scroll view.
