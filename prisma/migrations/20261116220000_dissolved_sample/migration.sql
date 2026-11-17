-- Additive only: one new table. Nothing existing is altered or removed.

-- CreateTable
CREATE TABLE "DissolvedSample" (
    "companyId" TEXT NOT NULL,
    "stratum" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "batch" TEXT NOT NULL,
    "frameSize" INTEGER NOT NULL,
    "drawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'selected',
    "records" INTEGER,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "DissolvedSample_pkey" PRIMARY KEY ("companyId")
);

-- CreateIndex
CREATE INDEX "DissolvedSample_stratum_status_idx" ON "DissolvedSample"("stratum", "status");

-- AddForeignKey
ALTER TABLE "DissolvedSample" ADD CONSTRAINT "DissolvedSample_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
