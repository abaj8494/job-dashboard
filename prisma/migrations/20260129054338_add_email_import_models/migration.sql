-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmail" TEXT NOT NULL,
    "emailDate" DATETIME NOT NULL,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "classification" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "isOutbound" BOOLEAN NOT NULL DEFAULT false,
    "extractedData" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" DATETIME,
    "jobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmailImport_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmailImport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_email_key" ON "EmailAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmailImport_messageId_key" ON "EmailImport"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailImport_jobId_key" ON "EmailImport"("jobId");

-- CreateIndex
CREATE INDEX "EmailImport_userId_status_idx" ON "EmailImport"("userId", "status");

-- CreateIndex
CREATE INDEX "EmailImport_userId_classification_idx" ON "EmailImport"("userId", "classification");

-- CreateIndex
CREATE INDEX "EmailImport_emailDate_idx" ON "EmailImport"("emailDate");
