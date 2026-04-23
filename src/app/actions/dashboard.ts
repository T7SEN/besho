"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export async function getNextVisitDate() {
  try {
    const event = await db.countdownEvent.findFirst({
      where: { isPrimary: true },
      orderBy: { targetDate: "asc" },
    });

    return { success: true, data: event?.targetDate ?? null };
  } catch (err) {
    console.error("Failed to fetch next visit:", err);
    return { success: false, error: "Failed to load countdown" };
  }
}

export async function setNextVisitDate(targetDate: Date) {
  try {
    // Clear old primary events
    await db.countdownEvent.updateMany({
      where: { isPrimary: true },
      data: { isPrimary: false },
    });

    // Create the new one
    await db.countdownEvent.create({
      data: {
        title: "Next Visit",
        targetDate,
        isPrimary: true,
      },
    });

    revalidatePath("/");
    return { success: true };
  } catch (err) {
    console.error("Failed to set next visit:", err);
    return { success: false, error: "Failed to save date" };
  }
}

export async function sendLovePing() {
  try {
    await db.ping.create({
      data: {
        senderAlias: "Partner", // We will refine user identities later
      },
    });
    return { success: true };
  } catch (err) {
    console.error("Failed to send ping:", err);
    return { success: false, error: "Failed to send ping" };
  }
}
