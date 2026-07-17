// NOTE: uses hooks/use-notifications.ts, which is still hardcoded MOCK data
// (not in current SPECIFICATION.md scope at all - no notifications backend
// exists). Kept as visual chrome per "don't remove Lovable UI" - flagged
// here for the end-of-sprint audit, not wired to anything real yet.

'use client';

import { Bell, Check } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/state/empty-state";
import {
  fallbackIcon,
  notificationIcon,
  useNotifications,
} from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

export function NotificationCenter() {
  const { items, unreadCount, markAllRead, markRead } = useNotifications();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              aria-hidden
              className="absolute right-2 top-2 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-medium">Notifications</p>
            {unreadCount > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {unreadCount} new
              </span>
            )}
          </div>
          {items.length > 0 && unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllRead}
              className="h-7 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
            >
              <Check className="mr-1 h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Bell}
              title="You're all caught up"
              description="Nera will let you know when there's something new."
            />
          </div>
        ) : (
          <ScrollArea className="max-h-[380px]">
            <ul className="divide-y divide-border/60">
              {items.map((n) => {
                const Icon = notificationIcon[n.type] ?? fallbackIcon;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => markRead(n.id)}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md",
                          n.read
                            ? "bg-muted text-muted-foreground"
                            : "bg-primary/10 text-primary",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="truncate text-[13px] font-medium">
                            {n.title}
                          </p>
                          {!n.read && (
                            <span
                              aria-hidden
                              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            />
                          )}
                        </div>
                        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                          {n.description}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground/80">
                          {formatDistanceToNowStrict(new Date(n.createdAt), {
                            addSuffix: true,
                          })}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}