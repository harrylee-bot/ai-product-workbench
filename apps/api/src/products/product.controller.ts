import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { CurrentRequestMeta } from "../common/request-meta.decorator";
import { CreateProductDto, ListProductsQueryDto, UpdateProductDto } from "./dto";
import { ProductService } from "./product.service";

@Controller("admin/products")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(user, dto, meta);
  }

  @Get()
  list(@Query() query: ListProductsQueryDto) {
    return this.products.list(query);
  }

  @Get(":productId")
  get(@Param("productId") productId: string) {
    return this.products.get(productId);
  }

  @Patch(":productId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("productId") productId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(user, productId, dto, meta);
  }

  @Delete(":productId")
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("productId") productId: string,
  ) {
    return this.products.delete(user, productId, meta);
  }
}
