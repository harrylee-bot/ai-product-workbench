import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AdminAuditTargetType, Prisma, Product } from "@prisma/client";
import { AdminAuditService } from "../admin/admin-audit.service";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateProductDto, ListProductsQueryDto, UpdateProductDto } from "./dto";

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit?: AdminAuditService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateProductDto, meta?: RequestMeta) {
    const product = await this.prisma.product.create({
      data: {
        name: dto.name.trim(),
        description: normalizeOptionalText(dto.description),
        createdBy: user.id,
      },
    });
    await this.recordAudit(user, "product.create", product.id, meta, {
      name: product.name,
    });
    return { product: this.toProduct(product) };
  }

  async list(query: ListProductsQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const keyword = query.keyword?.trim();
    const where: Prisma.ProductWhereInput = keyword
      ? {
          OR: [
            { name: { contains: keyword, mode: "insensitive" } },
            { description: { contains: keyword, mode: "insensitive" } },
          ],
        }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toProduct(item)),
      total,
      page,
      pageSize,
    };
  }

  async get(productId: string) {
    return { product: this.toProduct(await this.getProductRow(productId)) };
  }

  async update(user: AuthenticatedUser, productId: string, dto: UpdateProductDto, meta?: RequestMeta) {
    await this.getProductRow(productId);
    const data: Prisma.ProductUpdateInput = {
      name: dto.name === undefined ? undefined : dto.name.trim(),
      description: dto.description === undefined ? undefined : normalizeOptionalText(dto.description),
    };
    const compact = compactObject(data);
    if (!Object.keys(compact).length) throw new BadRequestException("PRODUCT_UPDATE_FAILED");

    const product = await this.prisma.product.update({
      where: { id: productId },
      data: compact,
    });
    await this.recordAudit(user, "product.update", product.id, meta, {
      name: product.name,
    });
    return { product: this.toProduct(product) };
  }

  async delete(user: AuthenticatedUser, productId: string, meta?: RequestMeta) {
    const product = await this.getProductRow(productId);
    await this.prisma.product.delete({ where: { id: product.id } });
    await this.recordAudit(user, "product.delete", product.id, meta, {
      name: product.name,
    });
    return { success: true, deletedProductId: product.id };
  }

  private async getProductRow(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException("PRODUCT_NOT_FOUND");
    return product;
  }

  private toProduct(product: Product) {
    return {
      id: product.id,
      name: product.name,
      description: product.description ?? undefined,
      createdBy: product.createdBy,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    };
  }

  private async recordAudit(
    admin: AuthenticatedUser,
    action: string,
    targetId: string,
    meta?: RequestMeta,
    detail?: Record<string, unknown>,
  ) {
    await this.audit?.record({
      admin,
      action,
      targetType: AdminAuditTargetType.product,
      targetId,
      detail,
      meta,
    });
  }
}

function normalizeOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
