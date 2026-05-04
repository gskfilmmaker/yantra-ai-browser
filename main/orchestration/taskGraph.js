'use strict'

// ── Task Graph (DAG) ──────────────────────────────────────────────────────────
// Nodes represent sub-tasks; directed edges encode "must complete before" deps.
// Supports branching (one task fans out to many) and merging (many → one).

class TaskGraph {
  constructor(graphId) {
    this.id      = graphId || `graph_${Date.now()}`
    this.nodes   = new Map()   // id → Node
    this.edges   = new Map()   // id → Set<id>  (id depends on these)
    this.reverse = new Map()   // id → Set<id>  (reverse: who depends on id)
  }

  // ── Mutation ───────────────────────────────────────────────────────────────

  addNode(node) {
    if (!node.id) throw new Error('Node must have an id')
    this.nodes.set(node.id, {
      id:          node.id,
      type:        node.type   || 'generic',
      description: node.description || '',
      agentHint:   node.agentHint   || null,
      params:      node.params      || {},
      state:       'pending',   // pending | running | completed | failed | skipped
      result:      null,
      error:       null,
      startedAt:   null,
      completedAt: null,
    })
    if (!this.edges.has(node.id))   this.edges.set(node.id, new Set())
    if (!this.reverse.has(node.id)) this.reverse.set(node.id, new Set())
    return this
  }

  // from must complete before to
  addEdge(from, to) {
    if (!this.nodes.has(from)) throw new Error(`Unknown node: ${from}`)
    if (!this.nodes.has(to))   throw new Error(`Unknown node: ${to}`)
    this.edges.get(to).add(from)       // `to` depends on `from`
    this.reverse.get(from).add(to)     // `from` unlocks `to`
    return this
  }

  // ── State mutations ────────────────────────────────────────────────────────

  setState(id, state, { result = null, error = null } = {}) {
    const node = this._node(id)
    node.state = state
    if (state === 'running')   node.startedAt   = Date.now()
    if (state === 'completed' || state === 'failed') {
      node.completedAt = Date.now()
      node.result      = result
      node.error       = error
    }
  }

  // ── Kahn's topological sort ────────────────────────────────────────────────
  // Returns ordered array of node ids (left = run first).
  // Throws if a cycle is detected.

  topologicalOrder() {
    const inDegree = new Map()
    for (const id of this.nodes.keys()) {
      inDegree.set(id, this.edges.get(id).size)
    }

    const queue  = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const order = []
    while (queue.length) {
      const id = queue.shift()
      order.push(id)
      for (const dependent of this.reverse.get(id)) {
        const newDeg = inDegree.get(dependent) - 1
        inDegree.set(dependent, newDeg)
        if (newDeg === 0) queue.push(dependent)
      }
    }

    if (order.length !== this.nodes.size) {
      throw new Error('Cycle detected in task graph')
    }
    return order
  }

  // ── Ready nodes ───────────────────────────────────────────────────────────
  // Returns ids of nodes whose dependencies have all completed.

  readyNodes() {
    const ready = []
    for (const [id, node] of this.nodes) {
      if (node.state !== 'pending') continue
      const deps = this.edges.get(id)
      const allDepsCompleted = [...deps].every(depId => {
        const dep = this.nodes.get(depId)
        return dep && dep.state === 'completed'
      })
      if (allDepsCompleted) ready.push(id)
    }
    return ready
  }

  // Returns true when no node is pending or running
  isFinished() {
    for (const node of this.nodes.values()) {
      if (node.state === 'pending' || node.state === 'running') return false
    }
    return true
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  toJSON() {
    const nodes = []
    for (const node of this.nodes.values()) {
      const deps = [...(this.edges.get(node.id) || [])]
      nodes.push({ ...node, dependsOn: deps })
    }
    return { id: this.id, nodes }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _node(id) {
    const n = this.nodes.get(id)
    if (!n) throw new Error(`Unknown node: ${id}`)
    return n
  }

  get size() { return this.nodes.size }
}

module.exports = { TaskGraph }
