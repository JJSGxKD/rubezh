-- CreateTable
CREATE TABLE "test_notice" (
    "account_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "first_accepted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "test_notice_pkey" PRIMARY KEY ("account_id")
);

-- AddForeignKey
ALTER TABLE "test_notice" ADD CONSTRAINT "test_notice_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Версия текста — с первой; первое принятие не позже принятия текущей версии.
ALTER TABLE "test_notice" ADD CONSTRAINT "test_notice_version_check" CHECK ("version" >= 1);
ALTER TABLE "test_notice" ADD CONSTRAINT "test_notice_first_check" CHECK ("first_accepted_at" <= "accepted_at");
