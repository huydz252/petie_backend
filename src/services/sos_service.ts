import { db } from "../repositories/database.js";
import { distanceKm, fuzz } from "../security.js";
import { getMessaging } from "firebase-admin/messaging";
import { createHmac } from "node:crypto";
// Stable offsets prevent an observer averaging repeated requests to recover a home address.
export function publicAlert(a: {
  id: string;
  lostLatitude: number;
  lostLongitude: number;
  contactPhone: string;
  [key: string]: unknown;
}) {
  const { contactPhone: _phone, ...safe } = a;
  const p = fuzz(
    a.lostLatitude,
    a.lostLongitude,
    createHmac("sha256", process.env.JWT_SECRET!).update(a.id).digest(),
  );
  return { ...safe, lostLatitude: p.latitude, lostLongitude: p.longitude };
}
export async function notifyNearby(
  authorId: string,
  latitude: number,
  longitude: number,
  petName: string,
  sosId: string,
): Promise<void> {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const users = await db.user.findMany({
    where: {
      id: { not: authorId },
      fcmToken: { not: null },
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { fcmToken: true, latitude: true, longitude: true },
  });
  const tokens = users
    .filter(
      (u) => distanceKm(latitude, longitude, u.latitude!, u.longitude!) <= 5,
    )
    .map((u) => u.fcmToken!);
  for (let i = 0; i < tokens.length; i += 500) {
    await getMessaging().sendEachForMulticast({
      tokens: tokens.slice(i, i + 500),
      notification: {
        title: "Một bạn nhỏ cần giúp đỡ",
        body: `${petName} đang thất lạc trong khu vực của bạn`,
      },
      data: { sosId },
    });
  }
}
