import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { SizesService } from '../sizes/sizes.service';
import {
  CreateSizeChartDto,
  SizeChartMeasurementDto,
  SizeChartResponseDto,
  SizeChartRowDto,
  UpdateSizeChartDto,
} from './dto/size-chart.dto';
import { MEASUREMENTS, MEASUREMENT_KEYS, MeasurementKey } from './measurements';
import { SizeChart, SizeChartDocument, SizeChartRow } from './schemas/size-chart.schema';

@Injectable()
export class SizeChartsService {
  constructor(
    @InjectModel(SizeChart.name) private readonly chartModel: Model<SizeChartDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    private readonly sizes: SizesService,
  ) {}

  // ------------------------------------------------------------------- reads

  /** The measurements a chart can carry, for the admin's form. */
  measurements(): SizeChartMeasurementDto[] {
    return MEASUREMENTS.map(({ key, label, group }) => ({ key, label, group }));
  }

  async list(): Promise<SizeChartResponseDto[]> {
    const charts = await this.chartModel
      .find({ ...notDeleted })
      .sort({ name: 1 })
      .exec();
    // One lookup for every chart's sizes, not one per chart.
    const sizes = await this.sizes.resolveMany(
      charts.flatMap((chart) => chart.rows.map((row) => row.sizeId.toString())),
    );
    return charts.map((chart) => SizeChartResponseDto.from(chart, sizes));
  }

  async findById(id: string): Promise<SizeChartResponseDto> {
    return this.present(await this.getDocumentOrThrow(id));
  }

  /** Refuse a chart id that does not resolve, so a product cannot point at nothing. */
  async assertExists(id: string): Promise<void> {
    const found =
      Types.ObjectId.isValid(id) && (await this.chartModel.exists({ _id: id, ...notDeleted }));
    if (!found) {
      throw new ValidationFailedException('That size chart does not exist', { sizeChartId: id });
    }
  }

  // ------------------------------------------------------------------ writes

  async create(dto: CreateSizeChartDto): Promise<SizeChartResponseDto> {
    await this.assertNameAvailable(dto.name);
    const table = await this.resolveTable(dto.measurements, dto.rows);

    const chart = await this.chartModel.create({
      name: dto.name,
      note: dto.note || null,
      measurements: table.measurements,
      rows: table.rows,
    });

    return this.present(chart);
  }

  async update(id: string, dto: UpdateSizeChartDto): Promise<SizeChartResponseDto> {
    const chart = await this.getDocumentOrThrow(id);

    if (dto.name !== undefined && dto.name !== chart.name) {
      await this.assertNameAvailable(dto.name, chart._id);
      chart.name = dto.name;
    }
    if (dto.note !== undefined) chart.note = dto.note || null;

    if (dto.measurements !== undefined || dto.rows !== undefined) {
      // The stored values are in the stored columns' order. Changing the
      // columns without restating the values would leave every one of them
      // under the wrong heading.
      if (dto.rows === undefined) {
        throw new ValidationFailedException(
          'Send the rows with the measurements, so every value lands in its column',
        );
      }
      const table = await this.resolveTable(dto.measurements ?? chart.measurements, dto.rows);
      chart.measurements = table.measurements;
      chart.rows = table.rows;
    }

    await chart.save();
    return this.present(chart);
  }

  /**
   * Soft delete, refused while live products still show the chart — the same
   * rule as a size or a category in use.
   */
  async remove(id: string): Promise<void> {
    const chart = await this.getDocumentOrThrow(id);

    const inUse = await this.productModel.countDocuments({
      sizeChartId: chart._id,
      ...notDeleted,
    });
    if (inUse > 0) {
      throw new ConflictException(
        `Cannot delete a size chart used by ${inUse} product(s); remove it from them first`,
      );
    }

    chart.deletedAt = new Date();
    await chart.save();
  }

  // ------------------------------------------------------------------ shared

  /**
   * Validate a chart's columns and rows together, and put both in order.
   *
   * The columns are stored in the order of `MEASUREMENTS`, whatever order they
   * arrived in, and each row's values are moved with them — so every chart
   * prints the same way. The rows are stored in the sizes' display order, and
   * every size must exist.
   */
  private async resolveTable(
    measurements: MeasurementKey[],
    rows: SizeChartRowDto[],
  ): Promise<{ measurements: MeasurementKey[]; rows: SizeChartRow[] }> {
    for (const row of rows) {
      if (row.values.length !== measurements.length) {
        throw new ValidationFailedException('Each size needs one value per measurement', {
          sizeId: row.sizeId,
          expected: measurements.length,
          received: row.values.length,
        });
      }
    }

    const ordered = [...measurements].sort(
      (a, b) => MEASUREMENT_KEYS.indexOf(a) - MEASUREMENT_KEYS.indexOf(b),
    );
    const sizes = await this.sizes.resolveMany(rows.map((row) => row.sizeId));
    const values = new Map(rows.map((row) => [row.sizeId, row.values]));

    return {
      measurements: ordered,
      rows: sizes.map((size) => {
        const sent = values.get(size.id.toString())!;
        return {
          sizeId: size.id,
          values: ordered.map((key) => sent[measurements.indexOf(key)]),
        };
      }),
    };
  }

  /** A chart with its sizes resolved now, so a renamed size shows renamed. */
  private async present(chart: SizeChartDocument): Promise<SizeChartResponseDto> {
    const sizes = await this.sizes.resolveMany(chart.rows.map((row) => row.sizeId.toString()));
    return SizeChartResponseDto.from(chart, sizes);
  }

  private async getDocumentOrThrow(id: string): Promise<SizeChartDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Size chart', id);
    const chart = await this.chartModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!chart) throw new ResourceNotFoundException('Size chart', id);
    return chart;
  }

  private async assertNameAvailable(name: string, excludeId?: Types.ObjectId): Promise<void> {
    const clash = await this.chartModel.exists({
      name,
      ...notDeleted,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (clash) throw new ConflictException(`A size chart named ${name} already exists`);
  }
}
