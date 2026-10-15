import type { GraphRow } from '@gitslappin/shared';
import { identiconUri } from '../../lib/identicon';

export const ROW_H = 22;
export const NODE_R = 9;
export const LANE_W = 17;
const X0 = 14;
const MID = ROW_H / 2;
const R = 8;

export const MID_Y = ROW_H / 2;
export const laneX = (lane: number): number => X0 + lane * LANE_W;
export const laneVar = (color: number): string => `var(--graph-color-${color})`;

function incomingPath(from: number, to: number): string {
  const xa = laneX(from);
  const xn = laneX(to);
  if (xa === xn) return `M${xa} 0V${MID}`;
  const s = xn > xa ? 1 : -1;
  return `M${xa} 0V${MID - R}Q${xa} ${MID} ${xa + s * R} ${MID}H${xn}`;
}

function outgoingPath(from: number, to: number): string {
  const xn = laneX(from);
  const xb = laneX(to);
  if (xn === xb) return `M${xn} ${MID}V${ROW_H}`;
  const s = xb > xn ? 1 : -1;
  return `M${xn} ${MID}H${xb - s * R}Q${xb} ${MID} ${xb} ${MID + R}V${ROW_H}`;
}

const line = (color: number, dashed = false) => ({
  stroke: laneVar(color),
  strokeWidth: 2,
  fill: 'none',
  strokeDasharray: dashed ? '2 3' : undefined,
});

interface Props {
  row: GraphRow;
  email: string;
  idKey: string;
  showConnector: boolean;
  current: boolean;
}

export function LaneSvg({ row, email, idKey, showConnector, current }: Props) {
  const x = laneX(row.lane);
  const width = laneX(row.laneCount) + LANE_W;
  const clipId = `clip-${idKey}`;
  return (
    <svg className="lane-svg" width={width} height={ROW_H} aria-hidden="true">
      {showConnector && <line x1={0} x2={x} y1={MID} y2={MID} style={{ stroke: laneVar(row.color), strokeWidth: 1 }} />}
      {row.through.map((t) => (
        <path key={`t${t.lane}`} d={`M${laneX(t.lane)} 0V${ROW_H}`} style={line(t.color, t.dashed)} />
      ))}
      {row.incoming.map((e) => (
        <path key={`i${e.lane}`} d={incomingPath(e.lane, row.lane)} style={line(e.color, e.dashed)} />
      ))}
      {row.outgoing.map((e, i) => (
        <path key={`o${i}`} d={outgoingPath(row.lane, e.lane)} style={line(e.color, row.stash)} />
      ))}
      <g transform={`translate(${x} ${MID})`}>
        {row.stash ? (
          <>
            <rect x={-8} y={-8} width={16} height={16} rx={2} className="stash-node" style={{ stroke: laneVar(row.color) }} />
            <path d="M-4 0h2.5l1 2h1l1-2H4v3.5h-8z" fill="none" style={{ stroke: laneVar(row.color) }} strokeWidth={1.2} />
          </>
        ) : row.merge ? (
          <circle r={4.5} style={{ fill: laneVar(row.color) }} data-node="merge" />
        ) : (
          <>
            <clipPath id={clipId}>
              <circle r={7} />
            </clipPath>
            <circle r={9} className="commit-ring" style={{ stroke: laneVar(row.color), strokeWidth: current ? 3 : 2 }} data-node="commit" />
            <image href={identiconUri(email)} x={-7} y={-7} width={14} height={14} clipPath={`url(#${clipId})`} style={{ imageRendering: 'pixelated' }} />
          </>
        )}
      </g>
    </svg>
  );
}

/** `linked`: a dotted line from this node down to the HEAD commit is drawn by the graph, so no stub here. */
export function WipSvg({ lane, linked }: { lane: number; linked: boolean }) {
  const x = laneX(lane);
  return (
    <svg className="lane-svg" width={laneX(lane + 1) + LANE_W} height={ROW_H} aria-hidden="true">
      {!linked && <path d={`M${x} ${MID + 9}V${ROW_H}`} style={{ stroke: laneVar(0), strokeWidth: 2, strokeDasharray: '2 3', fill: 'none' }} />}
      <circle cx={x} cy={MID} r={9} className="wip-node" style={{ stroke: laneVar(0) }} />
    </svg>
  );
}
