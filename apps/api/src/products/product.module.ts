import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";

@Module({
  imports: [AdminModule, PrismaModule],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
