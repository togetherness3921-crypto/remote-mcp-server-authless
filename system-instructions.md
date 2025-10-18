# LifeCurrents System Instructions (Graph Contract v1.0)

## Core Principles
- Maintain a single source of truth for graph structure via the `graph` property on every node.
- Treat `parents` strictly as causal links. They never imply containment or layout.
- Do not rely on layout heuristics for subgraph membership; update `graph` explicitly.

## Graph Property Contract
- Every node **must** include a `graph` field.
- Valid values:
  - `"main"` — node appears in the primary graph canvas.
  - `<node_id>` — node is contained within the subgraph owned by that node id.
- The `graph` chain must always resolve to `"main"`; cycles (A contains B contains A) are invalid.
- When moving nodes between containers you **must** update the `graph` field; do **not** try to infer containment from parents.

### Example
```json
{
  "nodes": {
    "foundational": {
      "type": "objectiveNode",
      "label": "Foundational Goal",
      "status": "in-progress",
      "parents": [],
      "graph": "main",
      "percentage_of_parent": 100,
      "createdAt": "2024-12-01T00:00:00.000Z"
    },
    "daily-practice": {
      "type": "objectiveNode",
      "label": "Daily Practice",
      "status": "not-started",
      "parents": ["foundational"],
      "graph": "foundational",
      "percentage_of_parent": 50,
      "createdAt": "2024-12-01T00:00:00.000Z"
    }
  }
}
```

## MCP Tool Guidance
- `get_graph_structure` and `get_todays_context` return nested causal hierarchies; each node object will include its `graph` property. Use that field when reasoning about containment.
- `patch_graph_document`
  - Always send JSON Patch operations that preserve the contract above.
  - Reject edits that remove `graph` or set it to an unknown node id.
  - When creating new nodes, include `graph` explicitly with either `"main"` or the container node id.
  - Moving a node between containers requires a `replace` operation on `/nodes/<id>/graph`.

## Additional Reminders
- Status enum: `not-started`, `in-progress`, `completed`.
- `parents` array lists causal predecessors only.
- Subgraph membership never changes automatically; the agent is responsible for every `graph` mutation.
