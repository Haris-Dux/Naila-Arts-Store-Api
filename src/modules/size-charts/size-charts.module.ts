import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { SizesModule } from '../sizes/sizes.module';
import { SizeChart, SizeChartSchema } from './schemas/size-chart.schema';
import { SizeChartsController } from './size-charts.controller';
import { SizeChartsService } from './size-charts.service';

/**
 * Size charts: the measurements of each size, chosen by products sold stitched.
 *
 * Registers the Product model for the same reason sizes does — it must refuse to
 * delete a chart products still show — and imports SizesModule, since a chart's
 * rows are sizes. ProductsModule depends on this one, never the reverse.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SizeChart.name, schema: SizeChartSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    SizesModule,
  ],
  controllers: [SizeChartsController],
  providers: [SizeChartsService],
  // Exported so products can refuse a chart that does not exist.
  exports: [SizeChartsService],
})
export class SizeChartsModule {}
