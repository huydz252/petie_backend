import {createOriginPolicy} from './cors_policy.js';
import {
  db,
  safeUser,
  HttpError,
  ownPet,
  member,
} from "./repositories/database.js";
import { publicAlert, notifyNearby } from "./services/sos_service.js";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import "dotenv/config";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { Prisma, PetSpecies } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { initializeApp, applicationDefault } from "firebase-admin/app";

import { distanceKm } from "./security.js";

const secret = process.env.JWT_SECRET ?? "";
const refreshSecret = process.env.REFRESH_SECRET ?? "";
if (secret.length < 32 || refreshSecret.length < 32 || secret === refreshSecret)
  throw new Error(
    "Set distinct JWT_SECRET and REFRESH_SECRET of at least 32 characters.",
  );
const firebase = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (firebase) initializeApp({ credential: applicationDefault() });
const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "loopback" ? "loopback" : false);
const http = createServer(app);
const originPolicy = createOriginPolicy(
  process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173',
  process.env.CORS_ALLOW_LOCALHOST === 'true',
);
const origin = (requestOrigin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => callback(null, originPolicy(requestOrigin));
const io = new Server(http, { cors: { origin } });
app.use(
  helmet(),
  cors({ origin }),
  express.json({ limit: "6mb" }),
  rateLimit({ windowMs: 60000, limit: 200 }),
);
interface AuthRequest extends Request {
  userId?: string;
}

const route =
  (handler: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
const uid = (req: AuthRequest) => req.userId!;
const api = express.Router();
const uploadPath = path.resolve("uploads");
app.use(
  "/uploads",
  express.static(uploadPath, {
    dotfiles: "deny",
    immutable: true,
    maxAge: "7d",
  }),
);

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const text = z.string().trim().min(1).max(2000);
const url = z
  .string()
  .url()
  .refine(
    (v) =>
      v.startsWith("https://") ||
      v.startsWith(process.env.PUBLIC_URL ?? "http://localhost:3000"),
    "Use HTTPS or configured PUBLIC_URL",
  );
const authSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(2).max(100).optional(),
});
function tokens(id: string) {
  return {
    accessToken: jwt.sign({ sub: id }, secret, { expiresIn: "15m" }),
    refreshToken: jwt.sign({ sub: id, type: "refresh" }, refreshSecret, {
      expiresIn: "7d",
    }),
  };
}
api.post(
  "/auth/register",
  rateLimit({ windowMs: 60000, limit: 10 }),
  route(async (req, res) => {
    const input = authSchema
      .extend({ fullName: z.string().trim().min(2).max(100) })
      .parse(req.body);
    const user = await db.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: await bcrypt.hash(input.password, 12),
        fullName: input.fullName,
      },
      select: safeUser,
    });
    res.status(201).json({ user, ...tokens(user.id) });
  }),
);
api.post(
  "/auth/login",
  rateLimit({ windowMs: 60000, limit: 10 }),
  route(async (req, res) => {
    const input = authSchema.parse(req.body);
    const user = await db.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash)))
      throw new HttpError(401, "Email hoặc mật khẩu không đúng");
    res.json({
      user: { id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl },
      ...tokens(user.id),
    });
  }),
);
api.post(
  "/auth/refresh",
  route(async (req, res) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string() })
      .parse(req.body);
    let p: jwt.JwtPayload;
    try {
      p = jwt.verify(refreshToken, refreshSecret) as jwt.JwtPayload;
    } catch {
      throw new HttpError(401, "Phiên đăng nhập hết hạn");
    }
    if (
      p.type !== "refresh" ||
      !p.sub ||
      !(await db.user.findUnique({ where: { id: p.sub } }))
    )
      throw new HttpError(401, "Token không hợp lệ");
    res.json(tokens(p.sub));
  }),
);
api.use((req: AuthRequest, _res, next) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) throw new Error();
    const p = jwt.verify(token, secret);
    if (typeof p === "string" || !p.sub) throw new Error();
    req.userId = p.sub;
    next();
  } catch {
    next(new HttpError(401, "Vui lòng đăng nhập lại"));
  }
});
api.post(
  "/media",
  route(async (req, res) => {
    const data = z
      .object({
        content: z.string().max(5600000),
        extension: z.enum(["jpeg", "jpg", "png", "webp"]),
      })
      .parse(req.body);
    const bytes = Buffer.from(data.content, "base64");
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    if (bytes.length > 4 * 1024 * 1024 || !(jpeg || png || webp))
      throw new HttpError(400, "Ảnh JPEG/PNG/WebP phải nhỏ hơn 4 MB");
    const name = `${randomUUID()}.${jpeg ? "jpg" : png ? "png" : "webp"}`;
    await mkdir(uploadPath, { recursive: true });
    await writeFile(path.join(uploadPath, name), bytes);
    res
      .status(201)
      .json({
        url: `${process.env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`}/uploads/${name}`,
      });
  }),
);
api.put(
  "/users/fcm",
  route(async (req, res) => {
    const data = z
      .object({ fcmToken: z.string().min(1).max(4096) })
      .parse(req.body);
    await db.user.update({ where: { id: uid(req) }, data });
    res.json({ ok: true });
  }),
);
api.put(
  "/users/location",
  route(async (req, res) => {
    const data = z
      .object({
        latitude,
        longitude,
        fcmToken: z.string().max(4096).optional(),
      })
      .parse(req.body);
    await db.user.update({ where: { id: uid(req) }, data });
    res.json({ ok: true });
  }),
);

const petInput = z.object({
  name: z.string().trim().min(1).max(80),
  species: z.nativeEnum(PetSpecies),
  breed: z.string().max(120),
  gender: z.enum(["MALE", "FEMALE", "NEUTERED"]),
  birthday: z.coerce.date().optional(),
  weightKg: z.number().positive().max(1000).optional(),
  avatarUrl: url.optional(),
  bio: z.string().max(1000).optional(),
});
api.get(
  "/pets",
  route(async (req, res) =>
    res.json(
      await db.pet.findMany({
        where: { ownerId: uid(req) },
        orderBy: { createdAt: "desc" },
      }),
    ),
  ),
);
api.post(
  "/pets",
  route(async (req, res) =>
    res
      .status(201)
      .json(
        await db.pet.create({
          data: { ...petInput.parse(req.body), ownerId: uid(req) },
        }),
      ),
  ),
);
api.get(
  "/pets/:petId",
  route(async (req, res) => {
    await ownPet(req.params.petId, uid(req));
    res.json(
      await db.pet.findUnique({
        where: { id: req.params.petId },
        include: {
          taggedPosts: { include: { post: true } },
          medicalLogs: true,
        },
      }),
    );
  }),
);
api.put(
  "/pets/:petId",
  route(async (req, res) => {
    await ownPet(req.params.petId, uid(req));
    res.json(
      await db.pet.update({
        where: { id: req.params.petId },
        data: petInput
          .partial()
          .extend({ isMissing: z.boolean().optional() })
          .parse(req.body),
      }),
    );
  }),
);
const postInclude = {
  author: { select: safeUser },
  taggedPets: { include: { pet: true } },
  comments: {
    take: 30,
    orderBy: { createdAt: "asc" as const },
    include: { user: { select: safeUser } },
  },
};
api.get(
  "/posts",
  route(async (req, res) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(10),
        species: z.nativeEnum(PetSpecies).optional(),
      })
      .parse(req.query);
    const where: Prisma.PostWhereInput = q.species
      ? { taggedPets: { some: { pet: { species: q.species } } } }
      : {};
    const posts = await db.post.findMany({
      where,
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      orderBy: { createdAt: "desc" },
      include: { ...postInclude, likes: { where: { userId: uid(req) } } },
    });
    res.json({
      items: posts.map(({ likes, ...p }) => ({
        ...p,
        liked: likes.length > 0,
      })),
      page: q.page,
      total: await db.post.count({ where }),
    });
  }),
);
api.post(
  "/posts",
  route(async (req, res) => {
    const input = z
      .object({
        caption: z.string().max(5000).optional(),
        mediaUrls: z.array(url).max(10).default([]),
        petIds: z.array(z.string()).max(10).default([]),
      })
      .refine(
        (v) => Boolean(v.caption?.trim()) || v.mediaUrls.length > 0,
        "Bài viết cần nội dung hoặc ảnh",
      )
      .parse(req.body);
    for (const id of input.petIds) await ownPet(id, uid(req));
    const { petIds, ...data } = input;
    res
      .status(201)
      .json(
        await db.post.create({
          data: {
            ...data,
            authorId: uid(req),
            taggedPets: {
              create: [...new Set(petIds)].map((petId) => ({ petId })),
            },
          },
          include: postInclude,
        }),
      );
  }),
);
api.post(
  "/posts/:postId/like",
  route(async (req, res) => {
    const result = await db.$transaction(
      async (tx) => {
        const postId = req.params.postId,
          userId = uid(req);
        const old = await tx.like.findUnique({
          where: { postId_userId: { postId, userId } },
        });
        if (old) {
          await tx.like.delete({
            where: { postId_userId: { postId, userId } },
          });
          await tx.post.update({
            where: { id: postId },
            data: { likeCount: { decrement: 1 } },
          });
        } else {
          await tx.like.create({ data: { postId, userId } });
          await tx.post.update({
            where: { id: postId },
            data: { likeCount: { increment: 1 } },
          });
        }
        return { liked: !old };
      },
      { isolationLevel: "Serializable" },
    );
    res.json(result);
  }),
);
api.post(
  "/posts/:postId/comments",
  route(async (req, res) => {
    const { content } = z.object({ content: text }).parse(req.body);
    const result = await db.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: { postId: req.params.postId, userId: uid(req), content },
      });
      await tx.post.update({
        where: { id: req.params.postId },
        data: { commentCount: { increment: 1 } },
      });
      return c;
    });
    res.status(201).json(result);
  }),
);
const medicalInput = z.object({
  logType: z.enum(["VACCINATION", "DEWORMING", "CHECKUP", "SURGERY"]),
  title: text,
  clinicName: z.string().max(200).optional(),
  performedAt: z.coerce.date(),
  nextDueDate: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});
api.post(
  "/pets/:petId/medical",
  route(async (req, res) => {
    await ownPet(req.params.petId, uid(req));
    res
      .status(201)
      .json(
        await db.medicalLog.create({
          data: { ...medicalInput.parse(req.body), petId: req.params.petId },
        }),
      );
  }),
);
api.get(
  "/pets/:petId/medical",
  route(async (req, res) => {
    await ownPet(req.params.petId, uid(req));
    res.json(
      await db.medicalLog.findMany({
        where: { petId: req.params.petId },
        orderBy: { performedAt: "desc" },
      }),
    );
  }),
);
api.get(
  "/medical",
  route(async (req, res) =>
    res.json(
      await db.medicalLog.findMany({
        where: { pet: { ownerId: uid(req) } },
        orderBy: { performedAt: "desc" },
      }),
    ),
  ),
);

api.post(
  "/sos",
  route(async (req, res) => {
    const data = z
      .object({
        petId: z.string(),
        lostLatitude: latitude,
        lostLongitude: longitude,
        lastSeenAddress: text,
        contactPhone: z.string().regex(/^[+\d ()-]{8,20}$/),
        rewardAmount: z.number().nonnegative().max(9999999999).optional(),
      })
      .parse(req.body);
    await ownPet(data.petId, uid(req));
    const alert = await db.$transaction(async (tx) => {
      await tx.pet.update({
        where: { id: data.petId },
        data: { isMissing: true },
      });
      return tx.sosAlert.create({
        data: { ...data, authorId: uid(req) },
        include: { pet: true },
      });
    });
    const safe = publicAlert(alert);
    io.emit("sos_broadcast", safe);
    void notifyNearby(
      uid(req),
      data.lostLatitude,
      data.lostLongitude,
      alert.pet.name,
      alert.id,
    ).catch((error) => console.error("FCM delivery failed", error));
    res.status(201).json(safe);
  }),
);
api.get(
  "/sos/nearby",
  route(async (req, res) => {
    const q = z
      .object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radius: z.coerce.number().positive().max(100).default(5),
      })
      .parse(req.query);
    const delta = q.radius / 111;
    const alerts = await db.sosAlert.findMany({
      where: {
        status: "MISSING",
        lostLatitude: { gte: q.lat - delta, lte: q.lat + delta },
      },
      include: { pet: true },
      orderBy: { reportedAt: "desc" },
      take: 1000,
    });
    res.json(
      alerts
        .filter(
          (a) =>
            distanceKm(q.lat, q.lng, a.lostLatitude, a.lostLongitude) <=
            q.radius,
        )
        .map(publicAlert),
    );
  }),
);
api.patch(
  "/sos/:sosId/resolve",
  route(async (req, res) => {
    const { status } = z
      .object({ status: z.enum(["FOUND", "CANCELLED"]).default("FOUND") })
      .parse(req.body);
    const a = await db.sosAlert.findFirst({
      where: { id: req.params.sosId, authorId: uid(req) },
    });
    if (!a) throw new HttpError(404, "Không tìm thấy báo cáo của bạn");
    await db.$transaction(async (tx) => {
      await tx.sosAlert.update({ where: { id: a.id }, data: { status } });
      if (
        (await tx.sosAlert.count({
          where: { petId: a.petId, status: "MISSING" },
        })) === 0
      )
        await tx.pet.update({
          where: { id: a.petId },
          data: { isMissing: false },
        });
    });
    io.emit("sos_broadcast", { id: a.id, status });
    res.json({ ok: true });
  }),
);

api.post(
  "/chat/rooms",
  route(async (req, res) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    if (userId === uid(req))
      throw new HttpError(400, "Không thể nhắn tin cho chính mình");
    const old = await db.chatRoom.findFirst({
      where: {
        AND: [
          { members: { some: { userId } } },
          { members: { some: { userId: uid(req) } } },
        ],
      },
    });
    res.json(
      old ??
        (await db.chatRoom.create({
          data: { members: { create: [{ userId }, { userId: uid(req) }] } },
        })),
    );
  }),
);
api.get(
  "/chat/rooms",
  route(async (req, res) => {
    const rooms = await db.chatRoom.findMany({
      where: { members: { some: { userId: uid(req) } } },
      include: {
        members: { include: { user: { select: safeUser } } },
        messages: { take: 1, orderBy: { createdAt: "desc" } },
      },
    });
    res.json(
      rooms.map((r) => ({
        id: r.id,
        name:
          r.members.find((m) => m.userId !== uid(req))?.user.fullName ??
          "Trò chuyện",
        lastMessage: r.messages[0]?.content ?? "",
      })),
    );
  }),
);
api.get(
  "/chat/rooms/:roomId/messages",
  route(async (req, res) => {
    await member(req.params.roomId, uid(req));
    const messages = await db.chatMessage.findMany({
      where: { roomId: req.params.roomId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(messages.reverse());
  }),
);
async function send(roomId: string, senderId: string, content: string) {
  await member(roomId, senderId);
  const msg = await db.chatMessage.create({
    data: { roomId, senderId, content },
  });
  io.to(roomId).emit("new_message", msg);
  return msg;
}
api.post(
  "/chat/rooms/:roomId/messages",
  route(async (req, res) => {
    const { content } = z.object({ content: text }).parse(req.body);
    res.status(201).json(await send(req.params.roomId, uid(req), content));
  }),
);
io.use((socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth.token, secret);
    if (typeof p === "string" || !p.sub) throw new Error();
    socket.data.userId = p.sub;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});
io.on("connection", (socket) => {
  socket.on(
    "join_room",
    async (value: unknown, ack?: (data: unknown) => void) => {
      try {
        const roomId = z.string().parse(value);
        await member(roomId, socket.data.userId);
        await socket.join(roomId);
        ack?.({ ok: true });
      } catch {
        ack?.({ error: "Forbidden" });
      }
    },
  );
  socket.on(
    "send_message",
    async (value: unknown, ack?: (data: unknown) => void) => {
      try {
        const d = z.object({ roomId: z.string(), content: text }).parse(value);
        ack?.(await send(d.roomId, socket.data.userId, d.content));
      } catch {
        ack?.({ error: "Cannot send message" });
      }
    },
  );
});
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/v1", api);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res
      .status(400)
      .json({
        message: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    res
      .status(error.code === "P2002" ? 409 : 400)
      .json({
        message:
          error.code === "P2002"
            ? "Dữ liệu đã tồn tại"
            : "Không thể thực hiện thao tác",
      });
    return;
  }
  console.error(error);
  res.status(500).json({ message: "Lỗi máy chủ. Vui lòng thử lại." });
});
http.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log("Petie API listening"),
);
async function shutdown() {
  io.close();
  http.close();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);


