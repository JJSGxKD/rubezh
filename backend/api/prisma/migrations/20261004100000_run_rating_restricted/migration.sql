-- Забег, сданный под ограничением рейтинга (docs/35-stage4-plan.md WP44):
-- в рейтинг не идёт ни сейчас, ни после снятия — ограниченное не копится.
-- Как ограничили: `notified` — игроку сообщили, `silent` — молча, и игрок
-- видит себя в досках на своём месте, а другие его нет.
ALTER TABLE "run" ADD COLUMN "rating_restricted" VARCHAR(8);
ALTER TABLE "run" ADD CONSTRAINT "run_rating_restricted_check" CHECK ("rating_restricted" IS NULL OR ("rating_restricted" IN ('notified', 'silent') AND NOT "ranked"));
