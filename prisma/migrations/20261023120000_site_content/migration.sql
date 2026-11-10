-- Website Content (CMS): new tables only. Nothing on "Company", "User", "Report", ingestion or any other existing table
-- changes, and no application data is inserted (the "home" row is created lazily by the first draft save).

CREATE TABLE "SiteContent" (
    "key" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "draftJson" JSONB,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "draftBaseVersion" INTEGER,
    "draftUpdatedAt" TIMESTAMP(3),
    "draftUpdatedById" TEXT,
    "publishedJson" JSONB,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteContent_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "SiteContentRevision" (
    "id" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "contentJson" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "restoredFromVersion" INTEGER,
    "note" TEXT,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteContentRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteContentRevision_contentKey_version_key" ON "SiteContentRevision"("contentKey", "version");
CREATE INDEX "SiteContentRevision_contentKey_createdAt_idx" ON "SiteContentRevision"("contentKey", "createdAt");

-- A content row that has history can never be deleted.
ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_contentKey_fkey" FOREIGN KEY ("contentKey") REFERENCES "SiteContent"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma cannot express these: JSON must be an object, content is capped at 128 KiB, and the version columns stay consistent.
ALTER TABLE "SiteContent" ADD CONSTRAINT "SiteContent_key_check" CHECK (char_length("key") BETWEEN 1 AND 64);
ALTER TABLE "SiteContent" ADD CONSTRAINT "SiteContent_draft_check" CHECK ("draftJson" IS NULL OR (jsonb_typeof("draftJson") = 'object' AND octet_length("draftJson"::text) <= 131072));
ALTER TABLE "SiteContent" ADD CONSTRAINT "SiteContent_published_check" CHECK ("publishedJson" IS NULL OR (jsonb_typeof("publishedJson") = 'object' AND octet_length("publishedJson"::text) <= 131072));
ALTER TABLE "SiteContent" ADD CONSTRAINT "SiteContent_versions_check" CHECK ("draftVersion" >= 0 AND "publishedVersion" >= 0 AND (("publishedVersion" = 0) = ("publishedJson" IS NULL)));

ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_kind_check" CHECK ("kind" IN ('publish', 'rollback'));
ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_version_check" CHECK ("version" >= 1);
ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_json_check" CHECK (jsonb_typeof("contentJson") = 'object' AND octet_length("contentJson"::text) <= 131072);
ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_rollback_check" CHECK (("kind" = 'rollback') = ("restoredFromVersion" IS NOT NULL));
ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "SiteContentRevision" ADD CONSTRAINT "SiteContentRevision_text_check" CHECK ((("note" IS NULL) OR char_length("note") <= 200) AND char_length("authorId") BETWEEN 1 AND 64 AND char_length("authorName") <= 200);

-- Append-only history: any UPDATE, DELETE or TRUNCATE of a revision is rejected, whoever issues it.
CREATE FUNCTION "site_content_revision_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'SiteContentRevision is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "SiteContentRevision_append_only_row" BEFORE UPDATE OR DELETE ON "SiteContentRevision" FOR EACH ROW EXECUTE PROCEDURE "site_content_revision_append_only"();
CREATE TRIGGER "SiteContentRevision_append_only_truncate" BEFORE TRUNCATE ON "SiteContentRevision" FOR EACH STATEMENT EXECUTE PROCEDURE "site_content_revision_append_only"();
