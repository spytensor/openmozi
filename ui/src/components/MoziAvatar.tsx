import { cn } from "@/lib/utils";

interface MoziAvatarProps {
  size?: number;
  className?: string;
}

/** The shared MOZI mark. */
export default function MoziAvatar({ size = 26, className }: MoziAvatarProps) {
  return (
    <span
      data-testid="mozi-avatar"
      className={cn("relative inline-flex shrink-0 select-none", className)}
      style={{ width: size, height: size }}
    >
      <img src="/mozi-mark.png" alt="" width={size} height={size} draggable={false} className="block h-full w-full" />
    </span>
  );
}
