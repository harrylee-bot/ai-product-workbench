import bcrypt from "bcryptjs";
import { PrismaClient, ProjectStatus, UserRole, UserStatus } from "@prisma/client";

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

  const user = await upsertUser({
    username: "zhangsan",
    email: "zhangsan@example.local",
    displayName: "张三",
    password: "User123456",
    role: UserRole.user,
  });

  const existingProject = await prisma.project.findFirst({
    where: {
      ownerId: user.id,
      title: "Triple System 默认项目",
      deletedAt: null,
    },
    include: { conversations: true },
  });

  if (!existingProject) {
    const project = await prisma.project.create({
      data: {
        ownerId: user.id,
        title: "Triple System 默认项目",
        description: "Seeded project for the AI Product Workbench evolution loop.",
        status: ProjectStatus.draft,
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        projectId: project.id,
        ownerId: user.id,
        title: "默认会话",
      },
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { currentConversationId: conversation.id },
    });
  } else if (!existingProject.currentConversationId) {
    const conversation = existingProject.conversations[0] ?? (await prisma.conversation.create({
      data: {
        projectId: existingProject.id,
        ownerId: user.id,
        title: "默认会话",
      },
    }));
    await prisma.project.update({
      where: { id: existingProject.id },
      data: { currentConversationId: conversation.id },
    });
  }

  console.log("Seed complete: admin/Admin123456, zhangsan/User123456, Triple System 默认项目");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
