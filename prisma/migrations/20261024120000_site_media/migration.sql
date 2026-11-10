-- Website editor images: one new table. Nothing on "Company", "User", "Report", ingestion or the Website Content tables changes,
-- and no data is inserted.

CREATE TABLE "SiteMedia" (
    "id" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "originalName" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteMedia_sha256_key" ON "SiteMedia"("sha256");
CREATE INDEX "SiteMedia_createdAt_idx" ON "SiteMedia"("createdAt");

-- Prisma cannot express these: only image types the site serves, a hard size cap (2.5 MiB) that must equal the real byte
-- length, sane dimensions, and well-formed ids and hashes.
ALTER TABLE "SiteMedia" ADD CONSTRAINT "SiteMedia_id_check" CHECK ("id" ~ '^[a-f0-9]{32}$');
ALTER TABLE "SiteMedia" ADD CONSTRAINT "SiteMedia_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$');
ALTER TABLE "SiteMedia" ADD CONSTRAINT "SiteMedia_mime_check" CHECK ("mimeType" IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE "SiteMedia" ADD CONSTRAINT "SiteMedia_size_check" CHECK ("byteSize" BETWEEN 1 AND 2621440 AND "byteSize" = octet_length("data"));
ALTER TABLE "SiteMedia" ADD CONSTRAINT "SiteMedia_dimensions_check" CHECK ("width" BETWEEN 1 AND 10000 AND "height" BETWEEN 1 AND 10000);
ALTER TABLE "SiteMedia" ADD CONSTRAINT "SiteMedia_text_check" CHECK ((("originalName" IS NULL) OR char_length("originalName") <= 120) AND char_length("uploadedById") BETWEEN 1 AND 64 AND char_length("uploadedByName") <= 200);

-- Immutable and permanent: a published or historical revision may refer to any image, so rows can never change or disappear.
CREATE FUNCTION "site_media_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'SiteMedia is immutable: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "SiteMedia_immutable_row" BEFORE UPDATE OR DELETE ON "SiteMedia" FOR EACH ROW EXECUTE PROCEDURE "site_media_immutable"();
CREATE TRIGGER "SiteMedia_immutable_truncate" BEFORE TRUNCATE ON "SiteMedia" FOR EACH STATEMENT EXECUTE PROCEDURE "site_media_immutable"();
