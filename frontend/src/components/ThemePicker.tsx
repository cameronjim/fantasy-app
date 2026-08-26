import { Palette, Check } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

// each row previews a theme by setting `data-theme` on a nested element, so daisyUI
// resolves the swatch to that theme's own palette.
export function ThemePicker(): JSX.Element {
  const { theme, setTheme, themes } = useTheme();

  const choose = (id: string): void => {
    setTheme(id);
    // daisyUI dropdowns close on blur.
    (document.activeElement as HTMLElement)?.blur();
  };

  return (
    <div className="dropdown dropdown-end">
      <button
        tabIndex={0}
        className="btn btn-ghost btn-sm btn-circle"
        aria-label="Choose theme"
        title="Theme"
      >
        <Palette size={16} />
      </button>
      <ul
        tabIndex={0}
        className="dropdown-content menu bg-base-200 rounded-box z-50 w-48 p-2 shadow-lg border border-base-300 mt-1"
      >
        <li className="menu-title text-xs">Theme</li>
        {themes.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => choose(t.id)}
              className="flex items-center justify-between"
              aria-current={theme === t.id}
            >
              <span className="flex items-center gap-2">
                <span
                  data-theme={t.id}
                  className="inline-flex overflow-hidden rounded-full border border-base-300"
                >
                  <span className="block w-3 h-4 bg-base-100" />
                  <span className="block w-3 h-4 bg-primary" />
                </span>
                {t.label}
              </span>
              {theme === t.id && <Check size={14} className="text-primary" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
