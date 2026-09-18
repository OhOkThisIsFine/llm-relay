import type { ReactElement } from "react";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: Readonly<{
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T> | T>;
  ariaLabel?: string;
  className?: string;
}>): ReactElement {
  const normalizedOptions: ReadonlyArray<SegmentOption<T>> = options.map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`segmented-control ${className ?? ""}`}
    >
      {normalizedOptions.map((opt) => {
        const isSelected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onValueChange(opt.value)}
            className={`segmented-option ${isSelected ? "active" : ""}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
