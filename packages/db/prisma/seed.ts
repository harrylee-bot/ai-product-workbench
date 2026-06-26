import bcrypt from "bcryptjs";
import { PrismaClient, UserRole, UserStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function upsertUser(input: {
  username: string;
  email: string;
  displayName: string;
  password: string;
  role: UserRole;
}) {
  const passwordHash = await bcrypt.hash(input.password, 12);

  return prisma.user.upsert({
    where: { username: input.username },
    update: {
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      status: UserStatus.active,
      passwordHash,
    },
    create: {
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      status: UserStatus.active,
      passwordHash,
    },
  });
}

async function main() {
  await upsertUser({
    username: "admin",
    email: "admin@example.local",
    displayName: "管理员",
    password: "Admin123456",
    role: UserRole.admin,
  });

  await upsertUser({
    username: "zhangsan",
    email: "zhangsan@example.local",
    displayName: "张三",
    password: "User123456",
    role: UserRole.user,
  });

  console.log("初始化完成：admin/Admin123456，zhangsan/User123456");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
