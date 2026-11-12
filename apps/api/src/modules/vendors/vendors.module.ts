import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { VENDOR_REPOSITORY } from './application/vendor-ports';
import { VendorsService } from './application/vendors.service';
import { PrismaVendorRepository } from './infrastructure/prisma-vendor.repository';
import { VendorsController } from './presentation/vendors.controller';

/**
 * Vendors (Phase 9): the organisation's outside contractors and their compliance documents.
 * Owns the vendor tables; maintenance gives work orders to active vendors.
 */
@Module({
  imports: [AccessControlModule],
  controllers: [VendorsController],
  providers: [VendorsService, { provide: VENDOR_REPOSITORY, useClass: PrismaVendorRepository }],
  exports: [VendorsService],
})
export class VendorsModule {}
