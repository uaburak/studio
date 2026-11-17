// Tooltip: appears after a short hover delay (instantly when another tooltip was just open),
// small dark capsule with an optional shortcut.
import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  type Placement,
  shift,
  useFloating,
} from "@floating-ui/react";
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

let lastClosedAt = 0;

export function Tooltip({
  label,
  shortcut,
  placement = "bottom",
  children,
  delay = 600,
}: {
  label: string;
  shortcut?: string;
  placement?: Placement;
  children: ReactElement;
  delay?: number;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!isValidElement(children)) return children;
  const show = () => {
    clearTimeout(timer.current);
    const warm = Date.now() - lastClosedAt < 400;
    timer.current = setTimeout(() => setOpen(true), warm ? 0 : delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (open) lastClosedAt = Date.now();
    setOpen(false);
  };
  const props = children.props as Record<string, unknown>;
  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: refs.setReference,
    onMouseEnter: (e: unknown) => {
      show();
      (props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: unknown) => {
      hide();
      (props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e);
    },
    onMouseDown: (e: unknown) => {
      hide();
      (props.onMouseDown as ((e: unknown) => void) | undefined)?.(e);
    },
    onBlur: (e: unknown) => {
      hide();
      (props.onBlur as ((e: unknown) => void) | undefined)?.(e);
    },
  });
  return (
    <>
      {trigger}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            role="tooltip"
            style={floatingStyles}
            className="pointer-events-none z-[100] animate-fade-in rounded-full bg-[var(--gray-800)] px-2 py-1 text-caption text-[var(--gray-40)] shadow-md whitespace-nowrap"
          >
            {label}
            {shortcut && <span className="ml-1.5 text-[var(--gray-350)]">{shortcut}</span>}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
