import { cn } from '@core/primitives/styling/browser/cn';

/** A workspace's short name in its initiative (e.g. "F"), as its lead refers to it. */
export function InitiativeLabel({ label, className }: { label: string; className?: string }) {
  return (
    <span
      aria-label={`Label ${label}`}
      title={`Label ${label} in the initiative`}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-border px-0.5 text-[10px] leading-none font-semibold text-foreground-secondary',
        className
      )}
    >
      {label}
    </span>
  );
}
