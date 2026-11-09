-- Победа над стражем рубежа (T-0121): что заявил итог забега. Засчитывает победу
-- вердикт `ok`, а не эти колонки.
ALTER TABLE "run" ADD COLUMN     "rubezh_cleared_sec" INTEGER,
ADD COLUMN     "rubezh_reached" BOOLEAN NOT NULL DEFAULT false;
