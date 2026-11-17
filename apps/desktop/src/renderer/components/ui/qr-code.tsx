// A QR code as crisp SVG (dark modules on a light tile; cameras need the contrast in dark mode
// too). Encoding: lib/qr.ts (byte mode, error correction M like the Mac's CoreImage code).
import { useMemo } from "react";
import { encodeQr, qrPath } from "../../lib/qr.ts";

export function QrCode({
  text,
  size = 168,
  margin = 1,
  label,
  className,
}: {
  text: string;
  /** Rendered width and height in px. */
  size?: number;
  /** Quiet zone in modules (the tile around it adds more). */
  margin?: number;
  label: string;
  className?: string;
}) {
  const matrix = useMemo(() => encodeQr(text), [text]);
  const extent = matrix.size + margin * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className={className}
      data-qr-version={matrix.version}
    >
      <path d={qrPath(matrix, margin)} fill="#111111" />
    </svg>
  );
}
