import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { SizeChart, SizeChartSchema } from '../size-charts/schemas/size-chart.schema';
import { Size, SizeSchema } from './schemas/size.schema';
import { SizesController } from './sizes.controller';
import { SizesService } from './sizes.service';

/**
 * The sizes a product can be offered in.
 *
 * Registers the Product and SizeChart models for the same reason categories
 * registers Product: it must refuse to delete a size products still offer or
 * size charts still list, and both of those modules depend on this one.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Size.name, schema: SizeSchema },
      { name: Product.name, schema: ProductSchema },
      { name: SizeChart.name, schema: SizeChartSchema },
    ]),
  ],
  controllers: [SizesController],
  providers: [SizesService],
  // Exported so products can resolve their size list and checkout can resolve
  // the size a customer picked.
  exports: [SizesService],
})
export class SizesModule {}
