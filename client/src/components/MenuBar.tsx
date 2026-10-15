const MENUS = ['File', 'Edit', 'View', 'Help'];

export function MenuBar() {
  return (
    <div className="menubar" data-testid="menubar">
      {MENUS.map((m) => (
        <span key={m} className="menubar-item">
          {m}
        </span>
      ))}
    </div>
  );
}
