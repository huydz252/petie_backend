import { PrismaClient } from "@prisma/client";
export const db = new PrismaClient();
export const safeUser = { id: true, fullName: true, avatarUrl: true } as const;
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function ownPet(id: string, userId: string) {
  const pet = await db.pet.findFirst({ where: { id, ownerId: userId } });
  if (!pet) throw new HttpError(404, "Không tìm thấy thú cưng của bạn");
  return pet;
}
export async function member(roomId: string, userId: string) {
  if (
    !(await db.chatMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    }))
  )
    throw new HttpError(403, "Bạn không thuộc cuộc trò chuyện");
}
