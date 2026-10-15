export interface GraphInput {
  sha: string;
  parents: string[];
  stash?: boolean;
}

export interface LaneRef {
  lane: number;
  color: number;
  /** Part of a stash line (drawn dotted). */
  dashed?: boolean;
}

export interface OutEdge extends LaneRef {
  parentSha: string;
}

export interface GraphRow {
  sha: string;
  lane: number;
  color: number;
  merge: boolean;
  stash: boolean;
  /** Lines running straight through this row (not touching the node). */
  through: LaneRef[];
  /** Lines coming from the top edge (at `lane`) down into the node; elbow when lane differs. */
  incoming: LaneRef[];
  /** Lines from the node to the bottom edge (at `lane`); elbow when lane differs. */
  outgoing: OutEdge[];
  /** Highest lane index touched in this row, plus one. */
  laneCount: number;
}

interface Lane {
  sha: string;
  color: number;
  dashed?: boolean;
}

/** State carried between pages. Treat as opaque and immutable. */
export interface GraphState {
  lanes: (Lane | null)[];
  nextColor: number;
}

export const GRAPH_COLORS = 10;

export function emptyGraphState(): GraphState {
  return { lanes: [], nextColor: 0 };
}

function freeLane(lanes: (Lane | null)[], blocked: Set<number>): number {
  for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && !blocked.has(i)) return i;
  return lanes.length;
}

/**
 * Incremental lane layout. Commits must be in graph order (children before parents).
 * Feeding the commits in several pages, passing back the returned state, gives the
 * same rows as feeding them all at once.
 */
export function layoutGraph(commits: GraphInput[], prev: GraphState = emptyGraphState()): { rows: GraphRow[]; state: GraphState } {
  const lanes: (Lane | null)[] = prev.lanes.map((l) => (l ? { ...l } : null));
  let nextColor = prev.nextColor;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    // Lanes waiting for this commit.
    const waiting: number[] = [];
    lanes.forEach((l, i) => {
      if (l && l.sha === c.sha) waiting.push(i);
    });
    const waitingSet = new Set(waiting);

    let lane: number;
    let color: number;
    if (waiting.length > 0) {
      lane = waiting[0]!;
      color = lanes[lane]!.color;
    } else {
      lane = freeLane(lanes, new Set());
      color = nextColor++ % GRAPH_COLORS;
    }
    const incoming: LaneRef[] = waiting.map((i) => ({ lane: i, color: lanes[i]!.color, ...(lanes[i]!.dashed ? { dashed: true } : {}) }));

    const through: LaneRef[] = [];
    lanes.forEach((l, i) => {
      if (l && !waitingSet.has(i)) through.push({ lane: i, color: l.color, ...(l.dashed ? { dashed: true } : {}) });
    });

    // Release the lanes that ended at this node.
    for (const i of waiting) lanes[i] = null;
    while (lanes.length <= lane) lanes.push(null);

    const outgoing: OutEdge[] = [];
    const blocked = new Set<number>([...waiting, lane]);
    c.parents.forEach((p, k) => {
      const existing = lanes.findIndex((l) => l !== null && l.sha === p);
      if (k > 0 && existing >= 0) {
        outgoing.push({ lane: existing, color: lanes[existing]!.color, parentSha: p });
      } else if (k === 0) {
        // The first parent always continues in the node's own lane, even when another lane
        // already waits for it; both lanes then merge when the parent row is reached.
        lanes[lane] = { sha: p, color, ...(c.stash ? { dashed: true } : {}) };
        outgoing.push({ lane, color, parentSha: p });
      } else {
        const target = freeLane(lanes, blocked);
        while (lanes.length <= target) lanes.push(null);
        const col = nextColor++ % GRAPH_COLORS;
        lanes[target] = { sha: p, color: col };
        blocked.add(target);
        outgoing.push({ lane: target, color: col, parentSha: p });
      }
    });

    let maxLane = lane;
    for (const e of [...incoming, ...through, ...outgoing]) maxLane = Math.max(maxLane, e.lane);
    rows.push({
      sha: c.sha,
      lane,
      color,
      merge: !c.stash && c.parents.length > 1,
      stash: !!c.stash,
      through,
      incoming,
      outgoing,
      laneCount: maxLane + 1,
    });
  }

  while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  return { rows, state: { lanes, nextColor } };
}
