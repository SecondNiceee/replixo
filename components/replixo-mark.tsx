/**
 * Знак Replixo — «Aperture»: кольцо и три ламели, смыкающиеся в треугольник.
 * Тот же рисунок, что MarkAperture на /logos; цвет наследуется через
 * currentColor, поэтому размер и цвет задаются снаружи классами.
 */
export function ReplixoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="17" stroke="currentColor" strokeWidth="3.5" />
      <g stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" opacity="0.85">
        <path d="M31.79 28.5 20.74 9.36" />
        <path d="M31.79 28.5 20.74 9.36" transform="rotate(120 24 24)" />
        <path d="M31.79 28.5 20.74 9.36" transform="rotate(240 24 24)" />
      </g>
    </svg>
  )
}
