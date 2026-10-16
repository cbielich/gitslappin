import { useState } from 'react';

export interface SelectOption {
  id: string;
  label: string;
}

/** A searchable select: typing filters the list, the x clears the choice. Test ids: `${prefix}-input`, `-option`, `-clear`. */
export function SearchSelect({ prefix, value, options, placeholder, onChange, disabled }: { prefix: string; value: string; options: SelectOption[]; placeholder: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState<string | null>(null); // null = show the chosen label
  const [open, setOpen] = useState(false);
  const chosen = options.find((o) => o.id === value)?.label ?? '';
  const q = (query ?? '').trim().toLowerCase();
  const shown = q === '' ? options : options.filter((o) => o.label.toLowerCase().includes(q));
  const close = (): void => {
    setOpen(false);
    setQuery(null);
  };
  return (
    <div className="rm-select">
      <input
        data-testid={`${prefix}-input`}
        className="rm-input"
        placeholder={placeholder}
        value={query ?? chosen}
        disabled={disabled}
        autoComplete="off"
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {value !== '' && !disabled && (
        <button type="button" className="rm-select-clear" data-testid={`${prefix}-clear`} aria-label="Clear" onClick={() => onChange('')}>
          ×
        </button>
      )}
      {open && (
        <div className="rm-select-list" role="listbox">
          {shown.map((o) => (
            <div
              key={o.id}
              className={`rm-select-option${o.id === value ? ' selected' : ''}`}
              data-testid={`${prefix}-option`}
              role="option"
              aria-selected={o.id === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.id);
                close();
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
