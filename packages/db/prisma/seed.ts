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
  // 仅在首次创建时写入口令与档案字段；已存在的用户不覆盖（用户改密后不会被 seed 回滚）。
  const passwordHash = await bcrypt.hash(input.password, 12);

  return prisma.user.upsert({
    where: { username: input.username },
    update: {},
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
  // 仅在库中无 admin 用户时执行（entrypoint 每次启动调用本脚本，避免反复重置口令）。
  const existingAdmin = await prisma.user.findFirst({
    where: { role: UserRole.admin, status: UserStatus.active },
  });
  if (existingAdmin) {
    console.log("已存在管理员账号，跳过 seed。");
    return;
  }

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

  console.log("初始化完成：admin/Admin123456，zhangsan/User123456（首次启动，请立即修改默认口令）");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
