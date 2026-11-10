-- Additive only: two new tables and one trigger. Nothing existing is altered or removed.

-- CreateTable
CREATE TABLE "CustomerTwoFactor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "pendingExpiresAt" TIMESTAMP(3),
    "lastStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTwoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTwoFactor_userId_key" ON "CustomerTwoFactor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorRecoveryCode_codeHash_key" ON "TwoFactorRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "TwoFactorRecoveryCode_userId_idx" ON "TwoFactorRecoveryCode"("userId");

-- AddForeignKey
ALTER TABLE "CustomerTwoFactor" ADD CONSTRAINT "CustomerTwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorRecoveryCode" ADD CONSTRAINT "TwoFactorRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Consent records are an audit trail: a row can never be edited once written (a change of mind is a NEW row). Deleting a
-- customer's account still removes their rows through the foreign key cascade, so erasure on request remains possible.
CREATE OR REPLACE FUNCTION "ConsentRecord_block_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ConsentRecord rows are immutable; record a new row instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConsentRecord_immutable" BEFORE UPDATE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION "ConsentRecord_block_update"();
