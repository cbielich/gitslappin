import { useEffect, type ReactNode } from 'react';
import { pushOverlay } from '../lib/shortcuts';

/** The GitKraken modal frame of the Clone and Create screens (21 / 22): title bar with a close X, one left-nav entry, a heading and the form. */
export function RepoModalFrame({ prefix, title, navLabel, heading, onClose, children }: { prefix: 'clone' | 'init'; title: string; navLabel: string; heading: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => pushOverlay(onClose), [onClose]);
  return (
    <div className="fb-scrim">
      <div className="rm-modal" data-testid={`${prefix}-modal`} role="dialog" aria-label={title}>
        <div className="rm-header">
          <h3 className="rm-title" data-testid={`${prefix}-title`}>
            {title}
          </h3>
          <button type="button" className="rm-close" data-testid={`${prefix}-close`} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="rm-body">
          <nav className="rm-nav">
            <div className="rm-nav-item selected" data-testid={`${prefix}-nav-item`}>
              {navLabel}
            </div>
          </nav>
          <div className="rm-content">
            <h4 className="rm-heading" data-testid={`${prefix}-heading`}>
              {heading}
            </h4>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One label + control row. */
export function RmRow({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="rm-row" {...(testId ? { 'data-testid': testId } : {})}>
      <label className="rm-label">{label}</label>
      <div className="rm-control">{children}</div>
    </div>
  );
}
