-- CreateTable
CREATE TABLE "DiscoveredJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "salary" TEXT,
    "url" TEXT,
    "description" TEXT,
    "postedDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'new',
    "matchScore" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    CONSTRAINT "DiscoveredJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DiscoveredJob_userId_status_idx" ON "DiscoveredJob"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredJob_externalId_source_key" ON "DiscoveredJob"("externalId", "source");
