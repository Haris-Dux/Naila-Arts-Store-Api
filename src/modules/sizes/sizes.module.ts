import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Size, SizeSchema } from './schemas/size.schema';
import { SizesController } from './sizes.controller';
import { SizesService } from './sizes.service';

/**
 * The sizes a product can be offered in.
 *
 * Registers the Product model for the same reason categories does: it must
 * refuse to delete a size products still offer, and ProductsModule depends on
 * this one.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Size.name, schema: SizeSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  controllers: [SizesController],
  providers: [SizesService],
  // Exported so products can resolve their size list and checkout can resolve
  // the size a customer picked.
  exports: [SizesService],
})
export class SizesModule {}
