-- V3__indexes.sql — secondary indexes (DM §6)
CREATE INDEX idx_plots_project_status ON plots(project_id, status);
CREATE INDEX idx_bookings_user        ON bookings(user_id, created_at DESC);
CREATE INDEX idx_bookings_due_expiry  ON bookings(expires_at) WHERE status = 'BLOCKED';
CREATE INDEX idx_bookings_plot        ON bookings(plot_id, created_at DESC);
CREATE INDEX idx_payments_booking     ON payments(booking_id);
CREATE INDEX idx_approvals_pending    ON approvals(status, created_at) WHERE status='PENDING';
CREATE INDEX idx_audit_entity         ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_otp_phone_time       ON otp_challenges(phone, created_at DESC);
CREATE INDEX idx_geometries_map       ON plot_geometries(site_map_id);
