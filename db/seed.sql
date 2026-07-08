-- seed.sql — dev/staging ONLY (DM §7). Idempotent: safe to run repeatedly.
-- Admin password for every admin user below: GemHousing@Dev1 (argon2id).

-- Admin users (one per role) + one customer.
INSERT INTO users (email, full_name, role, password_hash) VALUES
  ('super@gemhousing.in',  'Super Admin', 'SUPER_ADMIN',
   '$argon2id$v=19$m=65536,t=3,p=4$K03Y9dTV0sVMj3eVPOnYXQ$4wvFkux1kEWvoLS9MSq+IAvf94QXVRncYNPkLd2btTk'),
  ('ops@gemhousing.in',    'Ops User',    'OPERATIONS',
   '$argon2id$v=19$m=65536,t=3,p=4$K03Y9dTV0sVMj3eVPOnYXQ$4wvFkux1kEWvoLS9MSq+IAvf94QXVRncYNPkLd2btTk'),
  ('sales@gemhousing.in',  'Sales User',  'SALES',
   '$argon2id$v=19$m=65536,t=3,p=4$K03Y9dTV0sVMj3eVPOnYXQ$4wvFkux1kEWvoLS9MSq+IAvf94QXVRncYNPkLd2btTk'),
  ('finance@gemhousing.in','Finance User','FINANCE',
   '$argon2id$v=19$m=65536,t=3,p=4$K03Y9dTV0sVMj3eVPOnYXQ$4wvFkux1kEWvoLS9MSq+IAvf94QXVRncYNPkLd2btTk'),
  ('auditor@gemhousing.in','Auditor',     'AUDITOR',
   '$argon2id$v=19$m=65536,t=3,p=4$K03Y9dTV0sVMj3eVPOnYXQ$4wvFkux1kEWvoLS9MSq+IAvf94QXVRncYNPkLd2btTk')
ON CONFLICT (email) DO NOTHING;

-- Demo customer: email is the identity now (08 §4/§9); phone is an optional profile field.
INSERT INTO users (email, full_name, phone, role)
VALUES ('customer@demo.gemhousing.in', 'Demo Customer', '+919800000001', 'CUSTOMER')
ON CONFLICT (email) DO NOTHING;

-- Seller, project, map, plots, geometries (guarded so re-runs are no-ops).
DO $$
DECLARE
  v_seller uuid; v_project uuid; v_map uuid; v_p1 uuid; v_p2 uuid; v_p3 uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE slug = 'gem-meadows') THEN RETURN; END IF;

  INSERT INTO sellers (name, type) VALUES ('Gem Housing (Own)', 'OWN_COMPANY')
    RETURNING id INTO v_seller;

  INSERT INTO projects
    (seller_id, name, slug, description, address_line, district, state, pincode,
     status, rera_registered, rera_number, max_advance_percentage)
  VALUES
    (v_seller, 'Gem Meadows', 'gem-meadows',
     'Premium DTCP-approved plots with parks and wide roads.',
     'Gem Meadows Layout, Saravanampatti', 'Coimbatore', 'Tamil Nadu', '641035',
     'PUBLISHED', true, 'TN/29/LAYOUT/DEMO', 10.00)
    RETURNING id INTO v_project;

  INSERT INTO site_maps (project_id, version, image_key, width_px, height_px, is_active)
  VALUES (v_project, 1, 'seed/gem-meadows-v1.png', 2000, 1400, true)
    RETURNING id INTO v_map;

  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-01', 'E', '30 x 40 ft', 1200, 180000000) RETURNING id INTO v_p1;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-02', 'N', '30 x 50 ft', 1500, 225000000) RETURNING id INTO v_p2;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-03', 'W', '40 x 60 ft', 2400, 360000000) RETURNING id INTO v_p3;

  INSERT INTO plot_geometries (site_map_id, plot_id, polygon, centroid) VALUES
    (v_map, v_p1, '[[0.10,0.12],[0.28,0.12],[0.28,0.30],[0.10,0.30]]', '[0.19,0.21]'),
    (v_map, v_p2, '[[0.32,0.12],[0.50,0.12],[0.50,0.30],[0.32,0.30]]', '[0.41,0.21]'),
    (v_map, v_p3, '[[0.54,0.12],[0.78,0.12],[0.78,0.34],[0.54,0.34]]', '[0.66,0.23]');
END $$;
