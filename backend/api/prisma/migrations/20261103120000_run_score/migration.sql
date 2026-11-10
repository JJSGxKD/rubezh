-- Очки эффективности забега (T-0293, Р152): очки, пять осей, стиль и полоса силы,
-- а также исходные числа подсчёта для пересчёта прошлых забегов. Колонки пустые,
-- пока забег не посчитан: пролог, обучение, сбой подсчёта и забеги до задачи.
ALTER TABLE "run" ADD COLUMN     "axes" JSONB,
ADD COLUMN     "band" VARCHAR(16),
ADD COLUMN     "points" INTEGER,
ADD COLUMN     "score_input" JSONB,
ADD COLUMN     "style" VARCHAR(8);
