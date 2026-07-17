import { useCallback, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Bell, Target, TrendingUp, Sparkles, Wallet } from "lucide-react";

export type NotificationType =
  | "weekly_summary"
  | "budget_alert"
  | "goal_progress"
  | "transaction_synced";

export type AppNotification = {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  createdAt: string;
  read: boolean;
};

const seed: AppNotification[] = [
  {
    id: "n1",
    type: "weekly_summary",
    title: "Weekly summary ready",
    description: "You saved $340 this week — 12% more than last week.",
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    read: false,
  },
  {
    id: "n2",
    type: "budget_alert",
    title: "Dining budget almost reached",
    description: "You've spent $310 of your $350 monthly budget.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    read: false,
  },
  {
    id: "n3",
    type: "goal_progress",
    title: "New MacBook goal at 87%",
    description: "You're $400 away from your target.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    read: true,
  },
  {
    id: "n4",
    type: "transaction_synced",
    title: "New transaction synced",
    description: "Whole Foods Market · $128.42",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    read: true,
  },
];

export const notificationIcon: Record<NotificationType, LucideIcon> = {
  weekly_summary: Sparkles,
  budget_alert: Wallet,
  goal_progress: Target,
  transaction_synced: TrendingUp,
};

export const fallbackIcon = Bell;

export function useNotifications() {
  const [items, setItems] = useState<AppNotification[]>(seed);

  const unreadCount = items.filter((n) => !n.read).length;

  const markAllRead = useCallback(() => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const markRead = useCallback((id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const clearAll = useCallback(() => setItems([]), []);

  return { items, unreadCount, markAllRead, markRead, clearAll };
}