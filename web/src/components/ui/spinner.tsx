import { cn } from "@/lib/utils";

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md";
}

export function Spinner({ className, size = "sm", ...props }: SpinnerProps) {
  const dim = size === "sm" ? "h-4 w-4 border-2" : "h-5 w-5 border-[3px]";
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block animate-spin rounded-full border-current border-t-transparent",
        dim,
        className,
      )}
      {...props}
    />
  );
}