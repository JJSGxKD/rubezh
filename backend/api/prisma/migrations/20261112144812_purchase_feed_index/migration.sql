-- CreateIndex
CREATE INDEX "purchase_invoiced_at_purchase_id_idx" ON "purchase"("invoiced_at", "purchase_id");

