-- Settings of the machine rather than of a vault: dynamic DNS and HTTPS.
-- Not encrypted on purpose; see ARCHITECTURE.md, "Reaching PCP".

-- CreateTable
CREATE TABLE "host_setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);
