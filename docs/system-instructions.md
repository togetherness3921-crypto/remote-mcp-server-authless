# LifeCurrents MCP System Instructions (Worker Reference)

These instructions mirror the authoritative guidance that the AI agent receives when interacting with the LifeCurrents MCP worker. Update this document whenever the worker-side contract changes so the instructions can be synced to Supabase.

## Graph Contract v1.0 (Key Points)

1. **Node type** — Every node's `type` must be `"objectiveNode"`.
2. **Status enum** — Allowed values: `"not-started"`, `"in-progress"`, `"completed"`.
3. **Causal parents** — The `parents` array defines causal edges and nothing else.
4. **Explicit containment via `graph`**  
   - `graph: "main"` → the node lives in the top-level canvas.  
   - `graph: "<nodeId>"` → the node lives inside the named container node.  
   - The `graph` field is **mandatory** on every node. Blank, null, or missing values are rejected.  
   - The referenced container must already exist in the same document (unless the node itself is being deleted in the same patch).  
   - Nodes may not reference themselves and containment cycles (A → B → … → A) are invalid.
5. **Containment vs. causality** — `graph` communicates visual containment only. It never implies causality. Use `parents` to express causal relationships even when a node is rendered inside another node's subgraph.

## Tool Usage Guidance

- **Reading tools** (`get_graph_structure`, `get_todays_context`, etc.) always return a hierarchical JSON object based on `parents`, and every node in the payload includes its explicit `graph` membership.
- **`patch_graph_document`** accepts an array of RFC 6902 operations. When creating or editing nodes:
  - Always include a valid `graph` value.
  - If you move a node between subgraphs, update only its `graph` property; do not touch `parents` unless the causal structure actually changes.
  - Patches that remove a container must also remove or reassign every node that listed that container in `graph`.

Keep these instructions synchronized with the worker validation logic to maintain a single, precise source of truth for the LifeCurrents agentic workflow.
