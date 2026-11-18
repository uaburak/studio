// Icons: lucide (16 px, 1.5 stroke) plus the three platform marks drawn here.
import type { SVGProps } from "react";

// Posts and the post editor (wave 2A).
// Calendar, media, brand and iPhone panes (wave 2B).
export {
  ArrowRight as IconArrowRight,
  ArrowUp as IconArrowUp,
  Calendar as IconCalendar,
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  CircleAlert as IconAlert,
  CircleCheck as IconCircleCheck,
  CircleDashed as IconCircleDashed,
  CircleEllipsis as IconCircleEllipsis,
  CircleX as IconCircleX,
  Clock as IconClock,
  Copy as IconCopy,
  CopyPlus as IconDuplicate,
  Download as IconDownload,
  Ellipsis as IconEllipsis,
  Expand as IconExpand,
  Eye as IconEye,
  EyeOff as IconEyeOff,
  FileText as IconDocument,
  Film as IconVideo,
  Folder as IconFolder,
  Image as IconImage,
  ImagePlus as IconImagePlus,
  Laptop as IconLaptop,
  Layers as IconLayers,
  LayoutGrid as IconGrid,
  Link as IconLink,
  List as IconList,
  Maximize2 as IconMaximize,
  MessageSquare as IconChat,
  MessageSquarePlus as IconAddToChat,
  Mic as IconMic,
  Minimize2 as IconMinimize,
  Music as IconAudio,
  Package as IconPackage,
  Palette as IconPalette,
  PanelLeft as IconSidebar,
  Pencil as IconPencil,
  Play as IconPlay,
  Plus as IconPlus,
  Redo2 as IconRedo,
  RefreshCw as IconRefresh,
  RotateCcw as IconRestore,
  RotateCw as IconRetry,
  Search as IconSearch,
  Send as IconSend,
  Settings as IconSettings,
  Smartphone as IconPhone,
  Sparkles as IconSparkles,
  Square as IconSquare,
  SquarePlay as IconReel,
  Tablet as IconTablet,
  Tag as IconTag,
  Trash2 as IconTrash,
  TriangleAlert as IconWarning,
  Type as IconType,
  Undo2 as IconUndo,
  Upload as IconUpload,
  X as IconClose,
} from "lucide-react";

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 16, children, ...props }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconInstagram(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="3.2" />
      <circle cx="8" cy="8" r="2.6" />
      <circle cx="11.3" cy="4.7" r="0.5" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function IconFacebook(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8.9 13.5V7.6c0-.8.4-1.2 1.2-1.2h.8M7.2 9h3.2" />
    </Glyph>
  );
}

export function IconLinkedIn(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.4 7v3.8M5.4 5.1v.1M7.6 10.8V7m0 1.6c0-.9.7-1.6 1.6-1.6s1.4.6 1.4 1.5v2.3" />
    </Glyph>
  );
}

export function PlatformIcon({ platform, ...props }: GlyphProps & { platform: string }) {
  if (platform === "instagram") return <IconInstagram {...props} />;
  if (platform === "facebook") return <IconFacebook {...props} />;
  return <IconLinkedIn {...props} />;
}

/** The Studio mark (orange tile with a spark), used on the empty chat. */
export function StudioMark({ size = 44 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center bg-accent text-on-accent"
      style={{ width: size, height: size, borderRadius: size * 0.27 }}
    >
      <svg
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 3.5c.5 4.3 3.7 7.5 8 8-4.3.5-7.5 3.7-8 8-.5-4.3-3.7-7.5-8-8 4.3-.5 7.5-3.7 8-8Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
