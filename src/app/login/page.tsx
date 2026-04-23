"use client";

import { useActionState } from "react";
import { authenticate } from "../actions/auth";

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(authenticate, null);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4 transition-colors duration-500">
      <div className="w-full max-w-md space-y-8 rounded-2xl bg-card p-8 shadow-xl border border-border">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Welcome Home
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter your shared passcode to continue.
          </p>
        </div>

        <form action={formAction} className="mt-8 space-y-6">
          <div className="space-y-2">
            <label
              htmlFor="passcode"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-foreground"
            >
              Passcode
            </label>
            <input
              id="passcode"
              name="passcode"
              type="password"
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
              placeholder="••••••••"
            />
          </div>

          {state?.error && (
            <p className="text-sm font-medium text-destructive text-center">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 transition-all"
          >
            {isPending ? "Verifying..." : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
