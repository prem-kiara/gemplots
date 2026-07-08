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
-- Gem Meadows has 12 plots (D3, docs/11). P-01..P-03 rows are BYTE-IDENTICAL to the original seed
-- (numbers, prices, areas, facings, and their three geometry rows) — the test suite pins them.
-- P-04..P-12 are new. Layout (normalized coords, all in [0,1], aligned to db/assets/gem-meadows-v1.svg):
--   Row 1 (existing):  y 0.12–0.34, three plots  P-01 P-02 P-03
--   Horizontal road:   y 0.38–0.46
--   Row 2:             y 0.50–0.72, five plots    P-04 P-05 P-06 P-07 P-08   (x 0.06–0.94)
--   Horizontal road:   y 0.74–0.76 (thin)
--   Row 3:             y 0.78–0.94, four plots    P-09 P-10 P-11 P-12   + a park (x 0.78–0.94)
DO $$
DECLARE
  v_seller uuid; v_project uuid; v_map uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_p4 uuid; v_p5 uuid; v_p6 uuid;
  v_p7 uuid; v_p8 uuid; v_p9 uuid; v_p10 uuid; v_p11 uuid; v_p12 uuid;
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
  VALUES (v_project, 1, 'seed/gem-meadows-v1.svg', 2000, 1400, true)
    RETURNING id INTO v_map;

  -- Row 1 (BYTE-IDENTICAL — do not touch).
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-01', 'E', '30 x 40 ft', 1200, 180000000) RETURNING id INTO v_p1;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-02', 'N', '30 x 50 ft', 1500, 225000000) RETURNING id INTO v_p2;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-03', 'W', '40 x 60 ft', 2400, 360000000) RETURNING id INTO v_p3;

  -- Row 2 (new).
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-04', 'S',  '25 x 40 ft', 1000, 150000000) RETURNING id INTO v_p4;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-05', 'E',  '30 x 40 ft', 1200, 185000000) RETURNING id INTO v_p5;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-06', 'N',  '30 x 45 ft', 1350, 210000000) RETURNING id INTO v_p6;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-07', 'W',  '40 x 40 ft', 1600, 250000000) RETURNING id INTO v_p7;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-08', 'NE', '30 x 60 ft', 1800, 280000000) RETURNING id INTO v_p8;

  -- Row 3 (new).
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-09', 'SE', '40 x 50 ft', 2000, 310000000) RETURNING id INTO v_p9;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-10', 'SW', '40 x 55 ft', 2200, 340000000) RETURNING id INTO v_p10;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-11', 'NW', '40 x 60 ft', 2400, 375000000) RETURNING id INTO v_p11;
  INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
  VALUES (v_project, 'P-12', 'E',  '50 x 52 ft', 2600, 400000000) RETURNING id INTO v_p12;

  INSERT INTO plot_geometries (site_map_id, plot_id, polygon, centroid) VALUES
    -- Row 1 (BYTE-IDENTICAL geometry rows).
    (v_map, v_p1, '[[0.10,0.12],[0.28,0.12],[0.28,0.30],[0.10,0.30]]', '[0.19,0.21]'),
    (v_map, v_p2, '[[0.32,0.12],[0.50,0.12],[0.50,0.30],[0.32,0.30]]', '[0.41,0.21]'),
    (v_map, v_p3, '[[0.54,0.12],[0.78,0.12],[0.78,0.34],[0.54,0.34]]', '[0.66,0.23]'),
    -- Row 2: y 0.50–0.72, x from 0.06 in 0.18-wide bands with 0.02 gaps.
    (v_map, v_p4, '[[0.06,0.50],[0.22,0.50],[0.22,0.72],[0.06,0.72]]', '[0.14,0.61]'),
    (v_map, v_p5, '[[0.24,0.50],[0.40,0.50],[0.40,0.72],[0.24,0.72]]', '[0.32,0.61]'),
    (v_map, v_p6, '[[0.42,0.50],[0.58,0.50],[0.58,0.72],[0.42,0.72]]', '[0.50,0.61]'),
    (v_map, v_p7, '[[0.60,0.50],[0.76,0.50],[0.76,0.72],[0.60,0.72]]', '[0.68,0.61]'),
    (v_map, v_p8, '[[0.78,0.50],[0.94,0.50],[0.94,0.72],[0.78,0.72]]', '[0.86,0.61]'),
    -- Row 3: y 0.78–0.94, four plots left of the park (park occupies x 0.78–0.94).
    (v_map, v_p9,  '[[0.06,0.78],[0.22,0.78],[0.22,0.94],[0.06,0.94]]', '[0.14,0.86]'),
    (v_map, v_p10, '[[0.24,0.78],[0.40,0.78],[0.40,0.94],[0.24,0.94]]', '[0.32,0.86]'),
    (v_map, v_p11, '[[0.42,0.78],[0.58,0.78],[0.58,0.94],[0.42,0.94]]', '[0.50,0.86]'),
    (v_map, v_p12, '[[0.60,0.78],[0.76,0.78],[0.76,0.94],[0.60,0.94]]', '[0.68,0.86]');
END $$;
