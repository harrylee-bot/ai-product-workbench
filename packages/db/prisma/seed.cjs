const bcrypt = require("bcryptjs");
const { randomBytes } = require("node:crypto");
const { PrismaClient, UserRole, UserStatus } = require("@prisma/client");

const prisma = new PrismaClient();

async function upsertUser(input) {
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
  // 仅在库中无 admin 用户时执行。
  const existingAdmin = await prisma.user.findFirst({
    where: { role: UserRole.admin, status: UserStatus.active },
  });
  if (existingAdmin) {
    console.log("已存在管理员账号，跳过 seed。");
    return;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const generatedAdminPassword = isProduction ? "" : generateDevelopmentPassword();
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim() || generatedAdminPassword;
  if (!adminPassword) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD is required when seeding the first production admin.");
  }

  await upsertUser({
    username: process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || "admin",
    email: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || "admin@example.local",
    displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || "管理员",
    password: adminPassword,
    role: UserRole.admin,
  });

  const generatedDemoUserPassword = isProduction ? "" : generateDevelopmentPassword();
  const demoUserPassword = process.env.BOOTSTRAP_DEMO_USER_PASSWORD?.trim() || generatedDemoUserPassword;
  if (demoUserPassword) {
    await upsertUser({
      username: process.env.BOOTSTRAP_DEMO_USERNAME?.trim() || "zhangsan",
      email: process.env.BOOTSTRAP_DEMO_EMAIL?.trim() || "zhangsan@example.local",
      displayName: process.env.BOOTSTRAP_DEMO_DISPLAY_NAME?.trim() || "张三",
      password: demoUserPassword,
      role: UserRole.user,
    });
  }

  if (isProduction) {
    console.log("初始化完成：已创建首个管理员账号。");
  } else {
    console.log("初始化完成：已创建开发环境账号。");
    if (!process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      console.log(`开发管理员临时口令：admin/${generatedAdminPassword}`);
    }
    if (demoUserPassword && !process.env.BOOTSTRAP_DEMO_USER_PASSWORD) {
      console.log(`开发普通用户临时口令：zhangsan/${generatedDemoUserPassword}`);
    }
  }
}

function generateDevelopmentPassword() {
  return randomBytes(18).toString("base64url");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
