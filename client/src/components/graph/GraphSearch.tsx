import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { api } from '../../api';

const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  repoId: string;
  /** Changes every time Ctrl+F is pressed so the input regains focus. */
  focusNonce: number;
  onJump: (sha: string) => void;
  onMatches: (shas: string[]) => void;
  onClose: () => void;
}

export function GraphSearch({ repoId, focusNonce, onJump, onMatches, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [shas, setShas] = useState<string[]>([]);
  const [cur, setCur] = useState(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setShas([]);
      setCur(0);
      onMatches([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .search(repoId, text)
        .then((r) => {
          if (stale) return;
          setShas(r.shas);
          setCur(0);
          onMatches(r.shas);
          const first = r.shas[0];
          if (first) onJump(first);
        })
        .catch(() => {
          if (!stale) {
            setShas([]);
            onMatches([]);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, repoId]);

  const step = (dir: 1 | -1) => {
    if (shas.length === 0) return;
    const next = (cur + dir + shas.length) % shas.length;
    setCur(next);
    const sha = shas[next];
    if (sha) onJump(sha);
  };

  return (
    <div className="graph-search" data-testid="graph-search">
      <input
        ref={input}
        data-testid="graph-search-input"
        value={q}
        placeholder="Search commits"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(-1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onMatches([]);
            onClose();
          }
        }}
      />
      <span className="graph-search-count" data-testid="graph-search-count">
        {shas.length === 0 ? 0 : cur + 1} of {shas.length}
      </span>
      <button className="icon-btn" data-testid="graph-search-prev" title="Previous match" onClick={() => step(-1)}>
        <ChevronUp size={14} />
      </button>
      <button className="icon-btn" data-testid="graph-search-next" title="Next match" onClick={() => step(1)}>
        <ChevronDown size={14} />
      </button>
      <button
        className="icon-btn"
        data-testid="graph-search-close"
        title="Close"
        onClick={() => {
          onMatches([]);
          onClose();
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
