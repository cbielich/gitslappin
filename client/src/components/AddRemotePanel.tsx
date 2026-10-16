import { useState } from 'react';
import { X } from 'lucide-react';

interface Props {
  /** Runs the add; true = it worked (the panel closes), false = it failed (a toast shows and the panel stays). */
  onSubmit: (name: string, url: string, pushUrl?: string) => Promise<boolean>;
  onClose: () => void;
}

/** Screen 38: the Add Remote panel over the left of the graph. Only the URL tab exists. Texts: RemoteForm-* (en-us.json). */
export function AddRemotePanel({ onSubmit, onClose }: Props) {
  const [name, setName] = useState('');
  const [pull, setPull] = useState('');
  const [push, setPush] = useState('');
  const [working, setWorking] = useState(false);
  const ready = name.trim() !== '' && pull.trim() !== '' && !working;
  const submit = () => {
    if (!ready) return;
    setWorking(true);
    const pushUrl = push.trim() === '' ? undefined : push.trim();
    void onSubmit(name.trim(), pull.trim(), pushUrl).finally(() => setWorking(false));
  };
  return (
    <div className="add-remote-panel" data-testid="add-remote-panel" role="dialog" aria-label="Add Remote" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="add-remote-head">
        <span className="add-remote-title" data-testid="add-remote-title">
          Add Remote
        </span>
        <button className="icon-btn" data-testid="add-remote-close" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="add-remote-tabs">
        <span className="add-remote-tab active" data-testid="add-remote-tab-url">
          URL
        </span>
      </div>
      <label className="add-remote-label" data-testid="add-remote-name-label" htmlFor="add-remote-name">
        Name
      </label>
      <input id="add-remote-name" className="add-remote-input" data-testid="add-remote-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <label className="add-remote-label" data-testid="add-remote-pull-url-label" htmlFor="add-remote-pull-url">
        Pull URL
      </label>
      <input id="add-remote-pull-url" className="add-remote-input" data-testid="add-remote-pull-url" value={pull} onChange={(e) => setPull(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <label className="add-remote-label" data-testid="add-remote-push-url-label" htmlFor="add-remote-push-url">
        Push URL
      </label>
      <input id="add-remote-push-url" className="add-remote-input" data-testid="add-remote-push-url" value={push} onChange={(e) => setPush(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <button className="add-remote-submit" data-testid="add-remote-submit" disabled={!ready} onClick={submit}>
        Add Remote
      </button>
    </div>
  );
}
