-- 0005: a capture deferred by the kill switch (PURCHASES_ENABLED=false, #62). A verified webhook or the reconcile job
-- found the order approved while payments were off; the reconcile job captures it once they are back on, or marks it
-- FAILED and releases the hold if PayPal no longer allows the capture. NULL: nothing deferred.
ALTER TABLE payment_order ADD COLUMN capture_deferred_at timestamptz;
