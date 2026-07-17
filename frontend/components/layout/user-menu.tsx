'use client';

// Ported from Lovable's design (src/components/layout/user-menu.tsx).
// useAuth() (mock) replaced with real next-auth useSession()/signOut().

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LifeBuoy, LogOut, Settings, User } from 'lucide-react';
import { toast } from 'sonner';
import { useSession, signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function UserMenu() {
  const { data: session } = useSession();
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const displayName = session?.user?.nickname || session?.user?.name || 'Guest';
  const email = session?.user?.email ?? session?.user?.phoneNumber ?? '';
  const initials = displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const confirmSignOut = async () => {
    setConfirmOpen(false);
    toast.success('Signed out');
    await signOut({ redirectTo: '/login' });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 gap-2 rounded-full px-1.5 pr-2.5" aria-label="Account menu">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/10 text-[10.5px] font-semibold text-primary">
              {initials || 'N'}
            </span>
            <span className="hidden max-w-[120px] truncate text-[12.5px] font-medium sm:inline">
              {displayName}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-medium">{displayName}</span>
              <span className="truncate text-[11.5px] text-muted-foreground">{email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push('/dashboard/settings')}>
            <User className="h-4 w-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push('/dashboard/settings')}>
            <Settings className="h-4 w-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open('https://docs.lovable.dev', '_blank', 'noopener')}>
            <LifeBuoy className="h-4 w-4" />
            Help
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConfirmOpen(true)} className="text-destructive focus:text-destructive">
            <LogOut className="h-4 w-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log out of Nera?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll need to sign in again to access your dashboard and data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmSignOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Log out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
