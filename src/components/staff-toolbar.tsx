"use client";

import { VercelToolbar } from "@vercel/toolbar/next";

function useIsEmployee() {
  // Replace this stub with your auth library hook
  return false;
}

export function StaffToolbar() {
  const isEmployee = useIsEmployee();
  return isEmployee ? <VercelToolbar /> : null;
}
