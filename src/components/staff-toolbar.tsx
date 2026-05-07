"use client";

// src/components/staff-toolbar.tsx
//
// Gated mount of the Vercel production toolbar. Per Vercel's docs:
// "Before using the Vercel Toolbar in a production deployment, Vercel
// recommends conditionally injecting the toolbar. Otherwise, all
// visitors will be prompted to log in when visiting your site."
//
// Two gates, both must pass:
//
//   1. `currentAuthor === "T7SEN"` — Sir-only. Besho never sees the
//      toolbar and never gets prompted to log in to Vercel. An
//      unconditional mount produces an auth prompt for every visitor,
//      so the upstream author gate is the boundary that matters.
//
//   2. `!isNative()` — Capacitor APK skips it. The WebView has no
//      Vercel auth session and the toolbar UI doesn't fit the native
//      shell anyway. Web is the only sensible target.

import { useEffect, useState } from "react";
import { VercelToolbar } from "@vercel/toolbar/next";
import { getCurrentAuthor } from "@/app/actions/auth";
import { isNative } from "@/lib/native";

export function StaffToolbar() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isNative()) return;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const author = await getCurrentAuthor();
          setShow(author === "T7SEN");
        } catch {
          setShow(false);
        }
      })();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  return show ? <VercelToolbar /> : null;
}
