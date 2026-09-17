-- CreateTable
CREATE TABLE "feedback" (
    "feedback_id" UUID NOT NULL,
    "install_id" VARCHAR(64) NOT NULL,
    "platform_user_id" VARCHAR(32),
    "platform" "Platform" NOT NULL,
    "app_version" VARCHAR(64) NOT NULL,
    "answers" JSONB NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "runs" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("feedback_id")
);

-- CreateIndex
CREATE INDEX "feedback_created_at_idx" ON "feedback"("created_at");

-- CreateIndex
CREATE INDEX "feedback_install_id_idx" ON "feedback"("install_id");
