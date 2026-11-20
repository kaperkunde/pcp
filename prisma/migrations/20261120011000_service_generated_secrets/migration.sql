-- The secrets PCP made for a service's generated variables (#163).
ALTER TABLE "service_spec" ADD COLUMN "generated_secrets" TEXT NOT NULL DEFAULT '[]';
