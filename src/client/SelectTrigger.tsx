import type { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * A compact select styled like the board header's date filter: a themed
 * trigger pill (label + mono value + chevron) with the real native <select>
 * stretched invisibly over it, so keyboard, focus and the OS option list
 * all stay native while the resting state matches the rest of the UI.
 */
export function SelectTrigger({
  label,
  display,
  value,
  onChange,
  ariaLabel,
  title,
  disabled,
  children,
}: {
  label: string;
  display: ReactNode;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="date-trigger select-trigger" title={title}>
      <span>{label}</span>
      {display}
      <Icon name="chevron-down" size={11} />
      <select
        className="date-input-overlay"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </span>
  );
}
