import { Button } from "@/components/ui/button";

export function GoogleButton({
  onClick,
  disabled,
  label = "Continue with Google",
}: {
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-10 w-full gap-2 rounded-lg text-[13px] font-medium"
      onClick={onClick}
      disabled={disabled}
    >
      <GoogleGlyph />
      {label}
    </Button>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.2 14.7 2.2 12 2.2 6.9 2.2 2.8 6.3 2.8 11.4S6.9 20.6 12 20.6c6.9 0 9.5-4.8 9.5-8.6 0-.6 0-1-.1-1.8H12z"
      />
      <path
        fill="#4285F4"
        d="M21.4 12c0-.6 0-1-.1-1.8H12v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1v.1c3.6 0 6.4-1.2 8.4-3.3z"
      />
      <path
        fill="#FBBC05"
        d="M5.4 14.3A6 6 0 0 1 5 12c0-.8.1-1.6.4-2.3L2.6 7.5A9.2 9.2 0 0 0 2 12c0 1.6.4 3.1 1.1 4.5l2.3-2.2z"
      />
      <path
        fill="#34A853"
        d="M12 20.6c2.7 0 5-1 6.6-2.6l-3.1-2.5c-.9.6-2 1-3.5 1-2.6 0-4.8-1.7-5.6-4l-2.3 2.2C5.8 18.3 8.6 20.6 12 20.6z"
      />
    </svg>
  );
}