# DAG Studio WebMCP

**A human–AI causal DAG workspace for the OpenAI 2026 WebMCP Challenge.**

> The AI proposes. The researcher decides. The engine verifies.

[Live HTTPS sandbox](https://dag-studio-webmcp-sandbox.pages.dev/) · [Original DAG Studio](https://dagstudio.blackswancausallabs.com/) · [Apache 2.0 License](LICENSE)

## The problem

Causal directed acyclic graphs encode scientific assumptions: which variables cause which, what is measured or latent, and which paths may bias an effect estimate. Those decisions require domain expertise and scientific accountability. A general-purpose agent can help a researcher inspect and edit a graph, but visual browser automation is slow, ambiguous, and disconnected from the application's causal semantics.

DAG Studio WebMCP turns the existing DAG Studio interface into a shared workspace. A researcher can edit the canvas directly while an agent reads and updates that exact same graph through structured browser-native tools. Every agent mutation is visible and undoable. The causal engine checks the implications of the graph; neither the engine nor the agent claims to determine scientific truth.

## Why WebMCP matters

Without WebMCP, an agent must infer node identities, edge directions, and analysis controls from pixels and DOM structure. With WebMCP, DAG Studio explicitly exposes safe, purpose-built operations such as `add_node`, `add_edge`, and `analyze_current_dag`.

This enables a two-way collaboration that was difficult before:

1. The agent can read the live graph without scraping the interface.
2. The agent can propose a precise, attributed change.
3. The researcher immediately sees, moves, edits, accepts, or undoes it.
4. Human canvas edits are immediately visible to the agent.
5. The existing causal engine verifies backdoor paths and adjustment implications.
6. The agent can simulate reproducible data under competing DAG hypotheses and compare their structural and statistical implications.

## Live demonstration

Open [the sandbox](https://dag-studio-webmcp-sandbox.pages.dev/) in ChatGPT's WebMCP-capable browser or Chrome with `chrome://flags/#enable-webmcp-testing` enabled. The header displays **WebMCP connected** when tools are available.

Suggested prompt:

> Read the current DAG. Propose Smoking Status as a possible confounder, add it with arrows to Treatment and Outcome, then analyze the graph. Treat the additions as assumptions for my review and do not make any other changes.

The graph updates in place. Move the new node manually, then ask the agent to read the graph again to demonstrate that both participants share the same state.

## WebMCP tools

| Tool | Behavior |
| --- | --- |
| `get_current_dag` | Reads live nodes, roles, positions, directed edges, exposure, and outcome. |
| `add_node` | Adds a researcher-reviewable variable to the visible canvas. |
| `remove_node` | Removes a node and its incident edges. |
| `add_edge` | Adds a directed causal claim; duplicate, self, and cyclic edges are rejected. |
| `remove_edge` | Removes a directed causal claim. |
| `analyze_current_dag` | Returns open backdoor paths, minimal sufficient adjustment sets, identifiability, and diagnostics. |
| `check_adjustment_set` | Checks a proposed set against the encoded backdoor paths. |
| `generate_analysis_code` | Generates R/dagitty or Python/NetworkX code for the live graph. |
| `simulate_current_dag` | Runs the existing linear Gaussian SEM for the live graph, opens the visible simulation result, and returns bounded summaries, correlations, effect estimates, and a 10-row preview. |

The integration prefers the current `document.modelContext` API and includes a temporary `navigator.modelContext` fallback for hosts implementing an earlier WebMCP draft.

## Architecture

```text
Researcher edits canvas ─┐
                        ├─ React state + synchronous refs ─ DAG Studio engine
Agent calls WebMCP tools ┘                    │
                                             ├─ paths and adjustment sets
                                             ├─ diagnostics
                                             ├─ R/Python generation
                                             └─ reproducible simulation summaries
```

- `index.html` contains the existing React DAG Studio interface.
- `webmcp-tools.js` defines and registers the nine tools through dependency-injected access to the canvas's state refs, mutation wrappers, and existing simulation engine.
- `dag-engine.js` and `dag-engine.d.ts` are the existing DAG Studio causal engine and type declarations. The Challenge work calls this engine; it does not rewrite its causal algorithms.
- The graph, analysis, undo history, and WebMCP operations remain client-side.
- The static build is hosted over HTTPS on Cloudflare Pages.

## Human control and safety

Causal structure is an assertion, not a fact discovered by software. Tool descriptions and responses therefore frame mutations as proposals for researcher review. Agent changes:

- appear on the same canvas used for human editing;
- receive a visible agent-change notification;
- enter the same undo history as human changes;
- reject graph cycles and invalid node references; and
- return an explicit caveat that results depend on the encoded assumptions.

## Examples and the wider interface

The inherited DAG Studio interface includes canonical structures for confounding, mediation, collider bias, and M-bias, along with:

- drag-and-drop DAG editing and typed variables;
- exposure and outcome designation;
- highlighted causal and backdoor paths;
- minimal adjustment guidance and structural-role diagnostics;
- R and Python code generation and code-to-canvas workflows;
- client-side data simulation; and
- image, PDF, PowerPoint, and code export.

## What existed before August 25, 2026

The pre-Challenge baseline is the public [Black-Swan-Causal-Labs/dag-studio](https://github.com/Black-Swan-Causal-Labs/dag-studio) application at commit `31cc431612ba18a8bce1ab0841a88a0bb8b815f3`, dated July 8, 2026. It already contained the visual DAG editor, causal inference engine, educational examples, analysis panels, code console, simulation, export, and responsive UI.

The original application did **not** expose WebMCP tools, attribute agent graph edits, or test human/agent access to one shared graph state.

## Built specifically for the WebMCP Challenge

The following work was added during the Challenge submission period after August 25, 2026:

- nine WebMCP tools, including reproducible simulation of the live DAG;
- direct wiring from those tools to the canvas's existing shared state;
- WebMCP connection diagnostics and current/earlier API compatibility;
- visible, undoable agent-change attribution;
- automated tests for tool registration, agent mutations, human-to-agent state visibility, edge/node removal, cycle rejection, engine analysis, adjustment checks, code generation, simulation reproducibility, bounded results, and input validation;
- an isolated HTTPS sandbox that does not alter production DAG Studio; and
- Challenge-specific documentation and demo instructions.

## Run locally

```bash
git clone https://github.com/Black-Swan-Causal-Labs/dag-studio-webmcp.git
cd dag-studio-webmcp
npm install
npm run dev
```

Open the printed Vite URL. To expose native WebMCP in Chrome, enable `chrome://flags/#enable-webmcp-testing` and relaunch Chrome.

## Test and build

```bash
npm test
npm run build
```

The test command runs both the original DAG engine parity suite and the WebMCP/shared-state suite. The production build is a static `dist/` directory suitable for any HTTPS static host.

## Scientific basis

The causal engine implements d-separation and adjustment logic based on Pearl (2009), Greenland, Pearl & Robins (1999), and Textor et al. (2016). Effect-modification classification follows VanderWeele & Robins (2007) and Weinberg (2007). See the in-app About and Education sections for details.

## Author and license

John D. Diaz-Decaro, PhD, MS · [Black Swan Causal Labs](https://blackswancausallabs.com/)

Apache License 2.0 © 2026 John D. Diaz-Decaro, Black Swan Causal Labs, LLC. See [LICENSE](LICENSE).

The reused `dag-engine.js` and `dag-engine.d.ts` files originate in DAG Studio
and are shared with [`dagstudio-mcp`](https://github.com/Black-Swan-Causal-Labs/dagstudio-mcp).
All three projects distribute the engine under Apache License 2.0; the WebMCP
Challenge work calls the engine without rewriting its causal algorithms.

## Remote MCP clients

An optional [remote MCP bridge](mcp-bridge/README.md) connects other MCP clients to the same live browser canvas. Open the app, select **Connect MCP**, and enable a temporary connection. Native WebMCP continues to work without pairing. Registry metadata is in [`server.json`](server.json).
