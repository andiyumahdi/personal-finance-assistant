import { Suspense } from 'react';
import { LoginForm } from './login-form';

// useSearchParams() inside LoginForm requires a Suspense boundary in
// Next.js App Router (opts the page out of static rendering) - see
// https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
