import { Module } from "@nestjs/common";
import { BenchReportsController } from "./bench-reports.controller";
import { BenchReportsService } from "./bench-reports.service";
import { BenchReportsRepository } from "./bench-reports.repository";

@Module({
  controllers: [BenchReportsController],
  providers: [BenchReportsService, BenchReportsRepository],
})
export class BenchReportsModule {}
