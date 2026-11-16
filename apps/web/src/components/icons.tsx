import type { SVGProps } from "react";

/**
 * Hand-drawn 20px stroke icon set (1.5px strokes, round caps). Decorative by
 * default (aria-hidden); pair with visible text or an aria-label on the control.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconBrands = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1.5" />
    <circle cx="14" cy="6" r="3" />
    <path d="M3 17l3-5 3 5z" />
    <rect x="11" y="11" width="6" height="6" rx="3" />
  </Icon>
);

export const IconContents = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="2.5" width="11" height="13" rx="2" />
    <path d="M6.5 6h5M6.5 9h5M6.5 12h3" />
    <path d="M17 6v9.5a2 2 0 0 1-2 2H7" />
  </Icon>
);

export const IconCalendar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="14" height="13" rx="2" />
    <path d="M3 8h14M7 2.5v3M13 2.5v3" />
    <circle cx="10" cy="12.5" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconMedia = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <circle cx="7" cy="8" r="1.5" />
    <path d="M17.5 13l-4-4-7 7.5" />
  </Icon>
);

export const IconJobs = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h12M4 10h8M4 15h5" />
    <circle cx="15" cy="14" r="2.5" />
    <path d="M15 12.5V14l.9.6" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4v12M4 10h12" />
  </Icon>
);

export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4l-6 6 6 6" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 4l6 6-6 6" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 8l5 5 5-5" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 5l10 10M15 5L5 15" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10.5l4 4 8-9" />
  </Icon>
);

export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" />
    <path d="M15.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Icon>
);

export const IconUpload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 13V3.5M6 7.5l4-4 4 4" />
    <path d="M3.5 12.5v2a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2" />
  </Icon>
);

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="3.5" />
    <path d="M10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1" />
  </Icon>
);

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9z" />
  </Icon>
);

export const IconMonitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
    <path d="M7 17h6M10 13.5V17" />
  </Icon>
);

export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 5h10M7 10h10M7 15h10" />
    <circle cx="3.5" cy="5" r=".8" fill="currentColor" />
    <circle cx="3.5" cy="10" r=".8" fill="currentColor" />
    <circle cx="3.5" cy="15" r=".8" fill="currentColor" />
  </Icon>
);

export const IconGrid = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="11" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="11" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </Icon>
);

export const IconArrowLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M16 10H4M9 5l-5 5 5 5" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 5.5l.8 10.6a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L15 5.5" />
  </Icon>
);

export const IconArchive = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="15" height="4" rx="1" />
    <path d="M4 7.5v7.5a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15V7.5M8 11h4" />
  </Icon>
);

export const IconEdit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 3.5l3 3L7 16H4v-3z" />
    <path d="M11.5 5.5l3 3" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.5 1.5" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 2.5l6 2.2v4.6c0 4-2.6 6.8-6 8.2-3.4-1.4-6-4.2-6-8.2V4.7z" />
    <path d="M7.3 10l1.9 1.9 3.6-3.8" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3L2.5 16.5h15z" />
    <path d="M10 8v4" />
    <circle cx="10" cy="14.3" r=".6" fill="currentColor" />
  </Icon>
);

export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 2.5h6.5L15 6v11.5H5z" />
    <path d="M11.5 2.5V6H15" />
  </Icon>
);

export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 4.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-4.5 3v-3H3.5A1.5 1.5 0 0 1 2 13V6a1.5 1.5 0 0 1 1.5-1.5z" />
    <path d="M6.5 8h7M6.5 11h4.5" />
  </Icon>
);

export const IconSend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 15.5V4.5M5.5 9L10 4.5 14.5 9" />
  </Icon>
);

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <rect x="7.2" y="7.2" width="5.6" height="5.6" rx="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconUndo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7.5H12a4.5 4.5 0 1 1 0 9H8" />
    <path d="M7.5 4.5l-3 3 3 3" />
  </Icon>
);

export const IconRedo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.5 7.5H8a4.5 4.5 0 1 0 0 9h4" />
    <path d="M12.5 4.5l3 3-3 3" />
  </Icon>
);

export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10z" />
    <circle cx="10" cy="10" r="2.3" />
  </Icon>
);

export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 3l14 14M8.5 8.7a2.2 2.2 0 0 0 2.8 2.8" />
    <path d="M6.2 6.4C3.8 7.8 2 10 2 10s3 5.5 8 5.5c1.6 0 3-.5 4.2-1.2M11.8 4.8A8.3 8.3 0 0 0 10 4.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.2 2.9" />
  </Icon>
);

export const IconLayers = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3l7.5 4L10 11 2.5 7z" />
    <path d="M2.5 10.5L10 14.5l7.5-4M2.5 14L10 18l7.5-4" />
  </Icon>
);

export const IconArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 15.5V4.5M5.5 9L10 4.5 14.5 9" />
  </Icon>
);

export const IconArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4.5v11M5.5 11L10 15.5 14.5 11" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6L16.5 7" />
    <path d="M16.5 3.5V7H13" />
  </Icon>
);

export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 3.5h5.5V9M16 4l-7.5 7.5" />
    <path d="M14.5 11.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4" />
  </Icon>
);

export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3.5v9.5M6 9.5l4 4 4-4" />
    <path d="M3.5 14.5v1a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-1" />
  </Icon>
);

export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="12" r="3.5" />
    <path d="M9.6 9.4L16.5 2.5M14 5l2.5 2.5M12 7l2 2" />
  </Icon>
);

export const IconPlatform = ({ platform, ...p }: IconProps & { platform: string }) => {
  if (platform === "instagram")
    return (
      <Icon {...p}>
        <rect x="3" y="3" width="14" height="14" rx="4" />
        <circle cx="10" cy="10" r="3.2" />
        <circle cx="14.2" cy="5.8" r=".7" fill="currentColor" stroke="none" />
      </Icon>
    );
  if (platform === "facebook")
    return (
      <Icon {...p}>
        <circle cx="10" cy="10" r="7.5" />
        <path d="M11.5 17.3V11h2l.3-2.3h-2.3V7.4c0-.7.3-1.1 1.1-1.1h1.3v-2a12 12 0 0 0-1.9-.1c-1.8 0-2.9 1.1-2.9 3v1.5H7V11h2v6.4" />
      </Icon>
    );
  return (
    <Icon {...p}>
      <rect x="3" y="3" width="14" height="14" rx="2.5" />
      <path d="M6.5 8.5V14M6.5 6v.01M9.5 14V8.5M9.5 11c0-1.5 1-2.5 2.2-2.5s2 .8 2 2.4V14" />
    </Icon>
  );
};
