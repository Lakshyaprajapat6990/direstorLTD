-- Free customer accounts: which company profiles each customer has opened (their quota). One new table, additive only.
-- Nothing on "User", "Company", the CMS tables or any existing data is altered, and no rows are inserted.

CREATE TABLE "CustomerCompanyView" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCompanyView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerCompanyView_userId_companyId_key" ON "CustomerCompanyView"("userId", "companyId");

ALTER TABLE "CustomerCompanyView" ADD CONSTRAINT "CustomerCompanyView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
