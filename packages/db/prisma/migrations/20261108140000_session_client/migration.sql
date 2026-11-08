-- Sessions record the transport they were issued for (cookie for web, bearer for mobile) so a
-- token is only accepted on that transport. See ADR 0005.

-- CreateEnum
CREATE TYPE "SessionClient" AS ENUM ('WEB', 'MOBILE');

-- AlterTable
-- Existing rows (development only; no production deployment yet) become WEB sessions. The
-- temporary default is dropped so the application must always state the client explicitly.
ALTER TABLE "sessions" ADD COLUMN "client" "SessionClient" NOT NULL DEFAULT 'WEB';
ALTER TABLE "sessions" ALTER COLUMN "client" DROP DEFAULT;
