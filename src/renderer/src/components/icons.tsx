import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ name, children, className, ...rest }: IconProps & { name: string; children: ReactNode }): ReactNode {
  return (
    <svg
      className={`os-icon codicon codicon-${name}${className ? ` ${className}` : ""}`}
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconAdd(props: IconProps): ReactNode {
  return (
    <Icon name="add" {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Icon>
  );
}

export function IconArrowDown(props: IconProps): ReactNode {
  return (
    <Icon name="arrow-down" {...props}>
      <path d="M8 3v9.6M4.4 9.2L8 12.8l3.6-3.6" />
    </Icon>
  );
}

export function IconArrowLeft(props: IconProps): ReactNode {
  return (
    <Icon name="arrow-left" {...props}>
      <path d="M13 8H3.4M6.8 4.4L3.2 8l3.6 3.6" />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps): ReactNode {
  return (
    <Icon name="arrow-right" {...props}>
      <path d="M3 8h9.6M9.2 4.4L12.8 8l-3.6 3.6" />
    </Icon>
  );
}

export function IconArrowUp(props: IconProps): ReactNode {
  return (
    <Icon name="arrow-up" {...props}>
      <path d="M8 13V3.4M4.4 6.8L8 3.2l3.6 3.6" />
    </Icon>
  );
}

export function IconCheck(props: IconProps): ReactNode {
  return (
    <Icon name="check" {...props}>
      <path d="M3.4 8.6l3 3 6.2-6.8" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps): ReactNode {
  return (
    <Icon name="chevron-down" {...props}>
      <path d="M4.5 6.2L8 9.8l3.5-3.6" />
    </Icon>
  );
}

export function IconChevronLeft(props: IconProps): ReactNode {
  return (
    <Icon name="chevron-left" {...props}>
      <path d="M9.8 4.5L6.2 8l3.6 3.5" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps): ReactNode {
  return (
    <Icon name="chevron-right" {...props}>
      <path d="M6.2 4.5L9.8 8l-3.6 3.5" />
    </Icon>
  );
}

export function IconChevronUp(props: IconProps): ReactNode {
  return (
    <Icon name="chevron-up" {...props}>
      <path d="M4.5 9.8L8 6.2l3.5 3.6" />
    </Icon>
  );
}

export function IconClose(props: IconProps): ReactNode {
  return (
    <Icon name="close" {...props}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </Icon>
  );
}

export function IconCloudDownload(props: IconProps): ReactNode {
  return (
    <Icon name="cloud-download" {...props}>
      <path d="M4.9 10.9a2.7 2.7 0 0 1-.4-5.3 3.8 3.8 0 0 1 7.4-.9 2.65 2.65 0 0 1 .9 5.1" />
      <path d="M8 7.6v6M5.9 11.5L8 13.6l2.1-2.1" />
    </Icon>
  );
}

export function IconCollapse(props: IconProps): ReactNode {
  return (
    <Icon name="collapse" {...props}>
      <path d="M3.6 4.2L7.4 8l-3.8 3.8M8.6 4.2L12.4 8l-3.8 3.8" />
    </Icon>
  );
}

export function IconExpand(props: IconProps): ReactNode {
  return (
    <Icon name="expand" {...props}>
      <path d="M12.4 4.2L8.6 8l3.8 3.8M7.4 4.2L3.6 8l3.8 3.8" />
    </Icon>
  );
}

export function IconDashboard(props: IconProps): ReactNode {
  return (
    <Icon name="dashboard" {...props}>
      <path d="M2.6 12.2a5.4 5.4 0 1 1 10.8 0" />
      <path d="M8 12.2l2.5-3.6" />
      <circle cx="8" cy="12.2" r="0.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconEdit(props: IconProps): ReactNode {
  return (
    <Icon name="edit" {...props}>
      <path d="M3.2 12.8l.7-2.9 6.7-6.7a1.53 1.53 0 0 1 2.2 2.2l-6.7 6.7-2.9.7z" />
      <path d="M10 4.8l1.2 1.2" />
    </Icon>
  );
}

export function IconError(props: IconProps): ReactNode {
  return (
    <Icon name="error" {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.2 6.2l3.6 3.6M9.8 6.2L6.2 9.8" />
    </Icon>
  );
}

export function IconEye(props: IconProps): ReactNode {
  return (
    <Icon name="eye" {...props}>
      <path d="M2.2 8s2.3-3.8 5.8-3.8S13.8 8 13.8 8s-2.3 3.8-5.8 3.8S2.2 8 2.2 8z" />
      <circle cx="8" cy="8" r="1.6" />
    </Icon>
  );
}

export function IconEyeClosed(props: IconProps): ReactNode {
  return (
    <Icon name="eye-closed" {...props}>
      <path d="M2.4 8.6c1.6 1.8 3.5 2.7 5.6 2.7s4-.9 5.6-2.7" />
      <path d="M8 11.3v2.1M4.9 10.5l-1.1 1.8M11.1 10.5l1.1 1.8" />
    </Icon>
  );
}

export function IconFile(props: IconProps): ReactNode {
  return (
    <Icon name="file" {...props}>
      <path d="M4.2 1.8h4.6l3.4 3.4v8.2a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4V3.2a1.4 1.4 0 0 1 1.4-1.4z" />
      <path d="M8.8 1.8v3.6h3.4" />
    </Icon>
  );
}

export function IconFolder(props: IconProps): ReactNode {
  return (
    <Icon name="folder" {...props}>
      <path d="M2.2 4.4c0-.9.7-1.6 1.6-1.6h2.4c.47 0 .92.21 1.22.58l.88 1.02h4.28c.9 0 1.6.72 1.6 1.6v5.6c0 .88-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.72-1.6-1.6V4.4z" />
    </Icon>
  );
}

export function IconFolderOpen(props: IconProps): ReactNode {
  return (
    <Icon name="folder-opened" {...props}>
      <path d="M2.2 6.4V4.4c0-.9.7-1.6 1.6-1.6h2.4c.47 0 .92.21 1.22.58l.88 1.02h4.28c.9 0 1.6.72 1.6 1.6v1" />
      <path d="M2.1 12.1l1.6-3.7c.21-.49.69-.8 1.22-.8h8.06c.83 0 1.4.82 1.13 1.6l-1.03 2.95c-.19.55-.71.92-1.29.92H3.25c-.85 0-1.44-.84-1.15-1.64z" />
    </Icon>
  );
}

export function IconGear(props: IconProps): ReactNode {
  return (
    <Icon name="gear" {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <circle cx="8" cy="8" r="4.6" />
      <path d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5" />
    </Icon>
  );
}

export function IconGitBranch(props: IconProps): ReactNode {
  return (
    <Icon name="git-branch" {...props}>
      <circle cx="4.4" cy="3.6" r="1.5" />
      <circle cx="4.4" cy="12.4" r="1.5" />
      <circle cx="11.6" cy="8" r="1.5" />
      <path d="M4.4 5.1v5.8" />
      <path d="M11.6 9.5c0 2.5-4.6 1.5-7.2 2.6" />
    </Icon>
  );
}

export function IconGlobe(props: IconProps): ReactNode {
  return (
    <Icon name="globe" {...props}>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M2.4 8h11.2" />
      <path d="M8 2.3c1.6 1.6 2.4 3.5 2.4 5.7S9.6 12.1 8 13.7C6.4 12.1 5.6 10.2 5.6 8s.8-4.1 2.4-5.7z" />
    </Icon>
  );
}

export function IconHistory(props: IconProps): ReactNode {
  return (
    <Icon name="history" {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.3 1.4" />
    </Icon>
  );
}

export function IconImage(props: IconProps): ReactNode {
  return (
    <Icon name="image" {...props}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.8" />
      <circle cx="5.9" cy="6.6" r="0.95" />
      <path d="M4.6 12l2.7-3.3 2.1 2.6 1.65-1.9 1.75 2.6" />
    </Icon>
  );
}

export function IconMic(props: IconProps): ReactNode {
  return (
    <Icon name="mic" {...props}>
      <path d="M8 2.2a2.1 2.1 0 0 1 2.1 2.1v3.2a2.1 2.1 0 0 1-4.2 0V4.3A2.1 2.1 0 0 1 8 2.2z" />
      <path d="M5.2 7.5a2.8 2.8 0 0 0 5.6 0M8 10.3v2.2M6.2 12.5h3.6" />
    </Icon>
  );
}

export function IconMoreVertical(props: IconProps): ReactNode {
  return (
    <Icon name="more-vertical" {...props}>
      <circle cx="8" cy="3" r="0.75" fill="currentColor" />
      <circle cx="8" cy="8" r="0.75" fill="currentColor" />
      <circle cx="8" cy="13" r="0.75" fill="currentColor" />
    </Icon>
  );
}

export function IconRefresh(props: IconProps): ReactNode {
  return (
    <Icon name="refresh" {...props}>
      <path d="M13.2 8A5.2 5.2 0 1 1 11.5 4.2" />
      <path d="M13.4 2.4v2.9h-2.9" />
    </Icon>
  );
}

export function IconRobot(props: IconProps): ReactNode {
  return (
    <Icon name="robot" {...props}>
      <rect x="2.8" y="5.4" width="10.4" height="6.8" rx="1.8" />
      <path d="M8 5.4V3.6" />
      <circle cx="8" cy="2.7" r="0.9" />
      <path d="M5.9 8.1v1.7M10.1 8.1v1.7" />
    </Icon>
  );
}

export function IconSearch(props: IconProps): ReactNode {
  return (
    <Icon name="search" {...props}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.4 10.4l3.2 3.2" />
    </Icon>
  );
}

export function IconServer(props: IconProps): ReactNode {
  return (
    <Icon name="server" {...props}>
      <rect x="2.6" y="2.6" width="10.8" height="4.4" rx="1.2" />
      <rect x="2.6" y="9" width="10.8" height="4.4" rx="1.2" />
      <path d="M5 4.8h.01M5 11.2h.01" />
    </Icon>
  );
}

export function IconShield(props: IconProps): ReactNode {
  return (
    <Icon name="shield" {...props}>
      <path d="M8 1.9l4.6 1.7v3.6c0 3-1.8 5.2-4.6 6.6-2.8-1.4-4.6-3.6-4.6-6.6V3.6L8 1.9z" />
      <path d="M6.3 7.7l1.2 1.2 2.2-2.4" />
    </Icon>
  );
}

export function IconStarFilled(props: IconProps): ReactNode {
  return (
    <Icon name="star-full" {...props}>
      <path
        d="M8 2.2l1.7 3.5 3.9.5-2.9 2.7.7 3.9L8 10.9l-3.4 1.9.7-3.9L2.4 6.2l3.9-.5L8 2.2z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  );
}

export function IconSymbolEvent(props: IconProps): ReactNode {
  return (
    <Icon name="symbol-event" {...props}>
      <path d="M8 2.6L13.4 8 8 13.4 2.6 8 8 2.6z" />
    </Icon>
  );
}

export function IconStop(props: IconProps): ReactNode {
  return (
    <Icon name="stop" {...props}>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconTerminal(props: IconProps): ReactNode {
  return (
    <Icon name="terminal" {...props}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.8" />
      <path d="M5 6.6L7 8.4l-2 1.8M8.8 10.6h2.8" />
    </Icon>
  );
}

export function IconSidebarLeft(props: IconProps): ReactNode {
  return (
    <Icon name="sidebar-left" {...props}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <rect x="1.5" y="1.5" width="6.5" height="13" rx="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconSidebarRight(props: IconProps): ReactNode {
  return (
    <Icon name="sidebar-right" {...props}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <rect x="8" y="1.5" width="6.5" height="13" rx="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}
