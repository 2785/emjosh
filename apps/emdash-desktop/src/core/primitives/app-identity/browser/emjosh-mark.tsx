/** Emjosh's mark (a mint j on a dark rounded square); same artwork as src/assets/images/emjosh/emjosh.svg. */
export function EmjoshMark({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Emjosh"
    >
      <rect width="512" height="512" rx="112" fill="#13151B" />
      <path
        d="M346 215 V290 A90 90 0 0 1 166 290"
        fill="none"
        stroke="#A5F3C2"
        strokeWidth="64"
        strokeLinecap="round"
      />
      <circle cx="346" cy="138" r="34" fill="#F5F5F7" />
    </svg>
  );
}
