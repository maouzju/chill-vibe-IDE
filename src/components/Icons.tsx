import type { ButtonHTMLAttributes, SVGProps } from 'react'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  tone?: 'default' | 'primary' | 'danger'
}

const BaseIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" {...props} />
)

export const IconButton = ({
  label,
  tone = 'default',
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps) => (
  <button
    aria-label={label}
    title={label}
    type={type}
    className={`icon-button is-${tone}${className ? ` ${className}` : ''}`}
    {...props}
  >
    {children}
  </button>
)

export const CopyIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </BaseIcon>
)

export const CloseIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="m7 7 10 10M17 7 7 17" strokeLinecap="round" />
  </BaseIcon>
)

export const MinimizeWindowIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M6 12.5h12" strokeLinecap="round" />
  </BaseIcon>
)

export const MaximizeWindowIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </BaseIcon>
)

export const RestoreWindowIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M9 9.5h8.5V18H9z" />
    <path d="M6.5 15V6h8.5" strokeLinecap="round" />
  </BaseIcon>
)

export const FolderIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
  </BaseIcon>
)

export const ModelIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <rect x="4" y="5" width="16" height="14" rx="3" />
    <path d="M8 10h8M8 14h5" strokeLinecap="round" />
  </BaseIcon>
)

export const PlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </BaseIcon>
)

export const RefreshIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M20 11a8 8 0 1 0 2 5.3" />
    <path d="M20 5v6h-6" strokeLinecap="round" strokeLinejoin="round" />
  </BaseIcon>
)

export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <g transform="translate(-1, 0)">
      <path d="M19 12 5 5l3 7-3 7Z" strokeLinejoin="round" />
      <path d="M8 12h8" strokeLinecap="round" />
    </g>
  </BaseIcon>
)

export const SettingsIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.066 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.066-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.066Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3" />
  </BaseIcon>
)

export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
  </BaseIcon>
)

export const SwitchIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19.5 7A5.5 5.5 0 0 0 14 1.5M4.5 17A5.5 5.5 0 0 0 10 22.5" strokeLinecap="round" />
  </BaseIcon>
)

export const GitBranchIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="6" r="2" />
    <circle cx="18" cy="18" r="2" />
    <circle cx="6" cy="18" r="2" />
    <path d="M12 8v4a4 4 0 0 1-4 4H6M12 8v4a4 4 0 0 0 4 4h2" />
  </BaseIcon>
)

export const GptIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" {...props}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
)

export const ClaudeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="currentColor" stroke="none" {...props}>
    <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
  </svg>
)

export const MusicIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </BaseIcon>
)

/** NetEase Cloud Music logo */
export const NeteaseCloudMusicIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 1024 1024" fill="currentColor" stroke="none" {...props}>
    <path d="M627.086 5.115c28.132-7.672 58.822-7.672 86.953 0 33.247 7.672 63.937 23.017 89.512 43.477 10.23 7.673 17.902 15.344 23.017 28.131 7.672 17.903 5.114 38.363-5.115 53.708-7.672 12.787-23.017 23.017-40.92 25.574-12.787 2.558-25.574 0-38.362-7.672-5.115-2.558-10.23-10.23-17.902-12.787-17.902-10.23-35.804-20.46-56.264-17.903-15.345 0-28.132 7.673-35.804 17.903-10.23 10.23-12.788 23.017-10.23 35.804 7.672 25.574 12.787 53.706 20.46 79.281 51.15 2.558 99.74 15.345 143.218 40.92 40.92 25.575 79.28 58.821 109.97 97.183 25.575 33.247 46.035 71.61 56.265 112.53 12.786 43.476 17.901 89.51 12.786 132.986-2.557 38.363-10.23 74.166-23.016 109.971-33.247 84.396-92.07 161.12-171.35 209.713-56.265 35.803-122.76 58.821-189.253 66.493-46.034 5.115-92.069 5.115-138.102-2.557-94.627-15.345-181.58-61.38-250.631-130.431-66.495-66.493-112.53-153.448-132.99-245.516-7.671-69.052-7.671-138.103 7.673-207.154 17.903-81.84 61.38-161.12 117.644-222.5 48.592-51.15 107.414-89.511 171.35-117.643 7.672-2.558 12.787-5.115 20.46-7.673 15.344-2.557 30.69 0 43.477 10.23 17.902 12.788 25.574 33.248 23.017 53.707-2.557 20.46-17.902 38.363-35.805 46.034-63.937 25.575-122.758 69.052-163.678 122.76-38.362 53.705-63.936 112.527-71.608 173.906-7.672 61.38 0 122.758 20.46 181.58 30.69 84.396 94.626 156.004 173.907 196.924 48.592 25.575 102.298 38.362 156.005 38.362 43.477 0 89.511-7.672 130.43-23.017 35.805-12.787 71.61-33.247 99.741-58.822 28.133-23.016 51.15-53.706 66.495-84.396 7.672-15.345 17.901-33.247 20.46-51.15 15.344-51.149 17.901-107.413 2.556-158.561-12.786-43.478-38.361-81.84-71.609-109.971-15.344-12.787-30.69-25.575-48.592-35.805-15.344-7.672-30.69-15.345-48.591-17.902 12.788 46.034 23.018 92.07 35.804 135.545 2.558 10.23 5.115 23.018 5.115 33.248 2.558 46.033-15.344 94.625-46.034 130.43-28.132 33.246-69.052 58.821-112.528 66.494-46.034 10.23-97.184 0-138.103-25.575-38.362-25.574-66.494-63.936-81.84-104.856-7.672-23.017-12.787-48.591-12.787-74.166-2.556-56.264 12.788-109.971 43.478-156.005 35.804-53.707 94.625-92.07 158.562-109.971-5.115-17.902-10.23-35.805-12.787-53.707-12.787-38.361-10.23-81.839 7.672-115.086 10.23-20.46 23.018-38.361 40.92-51.15 23.016-20.46 43.476-33.246 66.494-40.918M478.753 419.424c-17.903 17.902-28.133 40.92-33.247 63.936-5.114 20.46-5.114 43.477 0 66.495 5.114 23.016 17.902 46.033 38.362 61.38 15.345 10.228 35.804 15.343 56.264 10.228 35.804-5.115 63.936-38.362 63.936-74.166-2.557-7.672-2.557-17.902-5.115-25.575-12.787-48.592-25.573-99.741-38.361-148.333-30.69 7.673-58.822 23.018-81.84 46.035z" />
  </svg>
)

export const TrashIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M5 7h14M9 7V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8V7M7 7l.8 11a2 2 0 0 0 2 1.85h4.4A2 2 0 0 0 16.2 18L17 7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 10.5v5M14 10.5v5" strokeLinecap="round" />
  </BaseIcon>
)

export const HistoryIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 7v5l4 2" strokeLinecap="round" />
  </BaseIcon>
)

export const SlidersIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <g transform="translate(-2, 0)">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </g>
  </BaseIcon>
)

export const HeadphonesIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
  </BaseIcon>
)

export const DiceIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1" fill="currentColor" stroke="none" />
  </BaseIcon>
)

export const PlayIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <polygon points="6,3 20,12 6,21" fill="currentColor" stroke="none" />
  </BaseIcon>
)

export const StickyNoteIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
    <path d="M14 3v4a2 2 0 0 0 2 2h4" />
  </BaseIcon>
)

export const CloudIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  </BaseIcon>
)

export const EyeIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </BaseIcon>
)

export const EyeOffIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </BaseIcon>
)

/* ── chill vibe icons ───────────────────────────────── */

/** Crescent moon — night mode / evening chill */
export const MoonIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" strokeLinejoin="round" />
  </BaseIcon>
)

/** Sun with rays — day mode / brightness */
export const SunIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" strokeLinecap="round" />
  </BaseIcon>
)

/** Coffee cup — chill coding session */
export const CoffeeIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M17 8h1a4 4 0 0 1 0 8h-1" />
    <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8Z" />
    <path d="M6 2v3M10 2v3M14 2v3" strokeLinecap="round" />
  </BaseIcon>
)

/** Leaf — zen / nature vibes */
export const LeafIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10Z" strokeLinejoin="round" />
    <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" strokeLinecap="round" />
  </BaseIcon>
)

/** Ocean wave — ambient / flow state */
export const WaveIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M2 12c1.5-1.5 3-3 5-3s3.5 3 5 3 3-3 5-3 3.5 1.5 5 3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 17c1.5-1.5 3-3 5-3s3.5 3 5 3 3-3 5-3 3.5 1.5 5 3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 7c1.5-1.5 3-3 5-3s3.5 3 5 3 3-3 5-3 3.5 1.5 5 3" strokeLinecap="round" strokeLinejoin="round" />
  </BaseIcon>
)

/** Sparkles — AI magic / generation */
export const SparklesIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z" strokeLinejoin="round" />
    <path d="M20 3v4M22 5h-4" strokeLinecap="round" />
  </BaseIcon>
)

/** Palette — theme / color customization */
export const PaletteIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <circle cx="13.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <path d="M12 2a10 10 0 0 0 0 20c1 0 1.5-.5 1.5-1.25 0-.35-.15-.65-.35-.9-.2-.25-.35-.55-.35-.9 0-.75.5-1.25 1.5-1.25H16a6 6 0 0 0 6-6c0-5.52-4.48-9.8-10-9.8Z" />
  </BaseIcon>
)

/** Timer — pomodoro / focus timer */
export const TimerIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 2h4" strokeLinecap="round" />
    <path d="M20.5 5.5l-1.5 1.5" strokeLinecap="round" />
  </BaseIcon>
)

/** Raindrop — rain ambience / weather */
export const RainDropIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
  </BaseIcon>
)

/** Bookmark — save / mark */
export const BookmarkIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z" strokeLinejoin="round" />
  </BaseIcon>
)

/** Pin — pin to top / sticky */
export const PinIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M12 17v5" strokeLinecap="round" />
    <path d="M5 17h14" strokeLinecap="round" />
    <path d="M7.5 17l1-7H9l1.5-5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1L15 10h.5l1 7" strokeLinejoin="round" />
  </BaseIcon>
)

/** Download — download / export */
export const DownloadIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="12" y1="15" x2="12" y2="3" strokeLinecap="round" />
  </BaseIcon>
)

/** Cat face — chill companion */
export const CatIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M12 22c4.97 0 9-3.13 9-7s-4.03-7-9-7-9 3.13-9 7 4.03 7 9 7Z" />
    <path d="M3 15V4l4.5 4.5M21 15V4l-4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="9" cy="14" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="0.8" fill="currentColor" stroke="none" />
    <path d="M10 17c.8.67 1.6 1 2 1s1.2-.33 2-1" strokeLinecap="round" />
  </BaseIcon>
)

/** Star — favorite / rate */
export const StarIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" strokeLinejoin="round" />
  </BaseIcon>
)

/** Heart — like / love */
export const HeartIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z" strokeLinejoin="round" />
  </BaseIcon>
)

/** Mountain landscape — scenery / outdoor zen */
export const MountainIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="m8 3 4 8 5-5 5 14H2L8 3Z" strokeLinejoin="round" />
    <path d="M4.14 15.08c2-1 3.5-1 5.5.5 2 1.5 3.5 1.5 5.5.5" strokeLinecap="round" />
  </BaseIcon>
)

/** Flame — streak / trending / warm */
export const FlameIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5Z" strokeLinejoin="round" />
  </BaseIcon>
)

/** Zap / lightning — quick action / energy */
export const ZapIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" strokeLinejoin="round" />
  </BaseIcon>
)

/** Wind — breeze / ambient airflow */
export const WindIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M17.7 7.7A2.5 2.5 0 1 1 19 11H2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.6 4.6A2 2 0 1 1 11 8H2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12.6 19.4A2 2 0 1 0 14 16H2" strokeLinecap="round" strokeLinejoin="round" />
  </BaseIcon>
)

export const FileTextIcon = (props: SVGProps<SVGSVGElement>) => (
  <BaseIcon {...props}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a1 1 0 0 0 1 1h4" />
    <path d="M10 13H8" />
    <path d="M16 17H8" />
    <path d="M16 13h-2" />
  </BaseIcon>
)
