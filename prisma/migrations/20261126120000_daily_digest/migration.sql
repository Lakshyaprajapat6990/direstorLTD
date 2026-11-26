-- Additive only: one new table. Nothing existing is altered or removed.
-- Stores the daily Companies House digest (Excel + PDF) produced by the scheduler's daily_digest job.

-- CreateTable
CREATE TABLE "DailyDigest" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "newCompanies" INTEGER NOT NULL DEFAULT 0,
    "dissolved" INTEGER NOT NULL DEFAULT 0,
    "officerCompanies" INTEGER NOT NULL DEFAULT 0,
    "directorRows" INTEGER NOT NULL DEFAULT 0,
    "xlsx" BYTEA NOT NULL,
    "xlsxBytes" INTEGER NOT NULL,
    "pdf" BYTEA NOT NULL,
    "pdfBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyDigest_day_key" ON "DailyDigest"("day");
